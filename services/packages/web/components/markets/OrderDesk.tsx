"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useReadContract } from "wagmi";
import { iOrryPriceOracleAbi } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { USDG_DECIMALS } from "@/lib/config";
import { ORRY } from "@/lib/orry/config";
import { useWallet } from "@/lib/orry/chain";
import { ago, amount, parseAmount, orry, span, toInput } from "@/lib/orry/format";
import { RELAY_ENABLED, type Market, type Mode } from "@/lib/markets/api";
import { phaseAt, useBalances, useFeeView, useMarketChain, usePoolPrice, useSeal, type Approval } from "@/lib/markets/chain";
import { SWAP_TOLERANCE_BPS } from "@/lib/markets/config";
import { assetFor, bpsLabel, cents, feedToPrice, feeOn, parsePrice, pricePerToken, usd, usdg, usdgFor, withTolerance } from "@/lib/markets/math";
import { AmountField, Fig, NoticeLine, Row, Segmented } from "../orry/parts";
import { clock } from "./parts";
import { useRuntime } from "./runtime";

type Side = "buy" | "sell";

/**
 * One order form for both venues: Private Swap (mode 1) sets the price limit from the stock's current price and a
 * tolerance; Dark Pool (mode 0) takes the limit price as typed. Either way the order is sealed in the open batch.
 */
export function OrderDesk({ mode, markets, symbol, onSymbol, fixed = false, skew = 0 }: { mode: Mode; markets: Market[]; symbol?: string; onSymbol?: (s: string) => void; fixed?: boolean; skew?: number }) {
  const m = markets.find((x) => x.symbol === symbol) ?? markets[0];
  const { address, connected, ready } = useWallet();
  const cfg = useMarketChain(m?.market);
  const fees = useFeeView(cfg, address);
  const bal = useBalances(cfg, address);
  const { seal, busy, notice } = useSeal();
  const rt = useRuntime();
  // Countdowns run on chain time: the API reports how far this browser's clock is from it.
  const now = rt.now + skew;

  const [side, setSide] = useState<Side>("buy");
  const [amt, setAmt] = useState("");
  const [limit, setLimit] = useState("");
  const [tol, setTol] = useState<number>(100);
  const [payOrry, setPayOrry] = useState(false);
  const [byRelay, setByRelay] = useState(false);

  const dec = m?.decimals ?? 18;
  const sym = m?.symbol ?? "";
  const sell = side === "sell";
  const price = m?.price ? feedToPrice(m.price.answer, m.price.decimals, dec) : undefined;

  // A fresh limit price starts at the stock's current price.
  useEffect(() => {
    setLimit(mode === 0 && price ? cents(pricePerToken(price, dec)) : "");
    setAmt("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.market, mode]);

  const start = cfg.start ?? m?.params.start;
  const cs = cfg.commitSeconds ?? m?.params.commitSeconds;
  const rs = cfg.revealSeconds ?? m?.params.revealSeconds;
  const feeBps = cfg.feeBps ?? m?.params.feeBps ?? 0;
  const minNotional = cfg.minNotionalUsdg ?? m?.params.minNotionalUsdg ?? 0n;
  // L3 from the market's own getter; the API's copy of the same value until the read lands.
  const l3 = cfg.orryFeeDiscountBps ?? m?.params.orryFeeDiscountBps;
  const poolListed = cfg.poolListed ?? m?.poolListed;
  const maxDev = cfg.maxDeviationBps ?? m?.params.maxDeviationBps;
  const phase = start && cs && rs ? phaseAt(now, start, cs, rs) : undefined;

  const amountIn = parseAmount(amt, sell ? dec : USDG_DECIMALS);
  const limitPrice = mode === 0 ? parsePrice(limit, dec) : price ? withTolerance(price, tol, sell) : undefined;

  // The same check the market buy script makes before it sends: a Private Swap order with no counter order fills only
  // through the pool, and the pool fills only inside the clearing band and the order's limit.
  const poolPrice = usePoolPrice(cfg);
  let poolNote: string | undefined;
  if (mode === 1 && poolListed === false) {
    poolNote = `${sym} has no Uniswap pool, so a swap fills only against a ${sell ? "buyer" : "seller"} in the same batch. If none seals, your ${sell ? sym : "USDG"} stays in your wallet.`;
  } else if (mode === 1 && poolListed && poolPrice !== undefined && price && limitPrice !== undefined && maxDev !== undefined) {
    const band = BigInt(maxDev);
    const high = (price * (10_000n + band)) / 10_000n;
    const low = (price * (10_000n - band)) / 10_000n;
    const fills = sell ? poolPrice > (limitPrice > low ? limitPrice : low) : poolPrice < (limitPrice < high ? limitPrice : high);
    if (!fills) {
      const diff = Number(((poolPrice - price) * 10_000n) / price) / 100;
      poolNote = `Right now the ${sym} pool trades ${Math.abs(diff).toFixed(2)}% ${diff >= 0 ? "above" : "below"} the market price, outside the ${bpsLabel(maxDev)} band, so it cannot fill this ${side}. It fills only against a ${sell ? "buyer" : "seller"} in the same batch. If none seals, your ${sell ? sym : "USDG"} stays in your wallet.`;
    }
  }
  const notional = amountIn === undefined || !price ? undefined : sell ? usdgFor(amountIn, price) : amountIn;
  const feeUsdg = notional === undefined ? undefined : feeOn(notional, feeBps, fees.discountBps);
  // A market built before ORRY existed (USDG-only, `OrryUnset` in its ORRY slots) has no ORRY fee path at all, so its
  // form shows neither the ORRY fee option nor a sealing fee: only a market wired to the live ORRY token does.
  const orryWired = Boolean(ORRY.token && cfg.orry && cfg.orry.toLowerCase() === ORRY.token.toLowerCase());
  const feeInOrry = payOrry && Boolean(fees.orryReady);
  // A seller's proceeds are net of a USDG fee; a fee paid in ORRY leaves them whole.
  const estOut = amountIn === undefined || !price || feeUsdg === undefined ? undefined : sell ? notional! - (feeInOrry ? 0n : feeUsdg) : assetFor(amountIn, price);

  const orryBasis = feeUsdg === undefined ? undefined : l3 === undefined ? feeUsdg : (feeUsdg * BigInt(10_000 - l3)) / 10_000n;
  const orryFee = useReadContract({
    address: cfg.orryPrice,
    abi: iOrryPriceOracleAbi,
    functionName: "orryFor",
    args: [orryBasis ?? 0n],
    query: { enabled: Boolean(cfg.orryPrice && fees.orryReady && orryBasis && orryBasis > 0n), refetchInterval: 15_000 },
  });
  const orryFeeEst = payOrry && fees.orryReady ? (orryFee.data as bigint | undefined) : undefined;

  const sealFee = fees.commitFeeOrry;
  const orryNeed = (sealFee ?? 0n) + (orryFeeEst ?? 0n);
  const maxBuyFee = amountIn !== undefined && !sell ? feeOn(amountIn, feeBps, 0) + 1n : 0n;
  const sealedHere = Boolean(
    phase && address && m && rt.all.some((o) => o.market.toLowerCase() === m.market.toLowerCase() && o.account.toLowerCase() === address.toLowerCase() && o.batch === phase.batch.toString() && o.state !== "missed"),
  );

  let problem: string | undefined;
  if (amountIn !== undefined && notional !== undefined && notional < minNotional) problem = `Orders start at ${usdg(minNotional)} USDG.`;
  else if (sell && amountIn !== undefined && bal.asset !== undefined && amountIn > bal.asset) problem = `Your wallet holds less ${sym} than this.`;
  else if (!sell && amountIn !== undefined && bal.usdg !== undefined && amountIn + maxBuyFee > bal.usdg) problem = "With the fee added, this needs more USDG than your wallet holds.";
  else if (ready && orryNeed > 0n && bal.orry !== undefined && orryNeed > bal.orry) problem = `Hold ${orry(orryNeed)} ORRY in your wallet to place this order.`;

  // A stale feed (weekends, US market holidays) means the batch would expire: sealing waits for the next session.
  const closed = m ? !m.fresh : false;
  const closing = phase ? phase.inCommit && phase.left < 8 : false;
  let label = sell ? "Seal sell order" : "Seal buy order";
  let blocked = !ready || !m || !price || amountIn === undefined || limitPrice === undefined || Boolean(problem) || Boolean(busy);
  if (closed) {
    label = "Opens at the next US trading session";
    blocked = true;
  } else if (!phase) blocked = true;
  else if (sealedHere) {
    label = "Your order is in this batch";
    blocked = true;
  } else if (!phase.inCommit || closing) {
    label = `New batch in ${span(phase.inCommit ? phase.left + (rs ?? 0) : phase.left)}`;
    blocked = true;
  } else if (busy) label = busy;

  async function onSeal() {
    if (!m || !address || !phase || amountIn === undefined || limitPrice === undefined || !cfg.asset || !cfg.usdg || !start || !cs || rs === undefined) return;
    const approvals: Approval[] = sell ? [{ token: cfg.asset, symbol: sym, amount: amountIn }] : [{ token: cfg.usdg, symbol: "USDG", amount: amountIn + maxBuyFee }];
    // The sealing fee is burned at commit; a fee paid in ORRY is taken at clearing, at the price then, so it keeps room.
    const orryAllowance = ((sealFee ?? 0n) * 11n) / 10n + ((orryFeeEst ?? 0n) * 3n) / 2n;
    if (orryAllowance > 0n && cfg.orry) approvals.push({ token: cfg.orry, symbol: "ORRY", amount: orryAllowance });
    const id = await seal({
      market: m.market,
      symbol: sym,
      assetDecimals: dec,
      account: address,
      timing: { start: start!, commitSeconds: cs!, revealSeconds: rs },
      order: { sellAsset: sell, amountIn, limitPrice, mode, payFeeInOrry: payOrry && Boolean(fees.orryReady) },
      approvals,
      relay: RELAY_ENABLED && byRelay,
      pooled: mode === 1 && Boolean(poolListed),
    });
    if (id) setAmt("");
  }

  const effBps = (feeBps * (10_000 - fees.discountBps)) / 10_000;
  const maxIn = sell ? bal.asset : bal.usdg !== undefined ? (bal.usdg * 10_000n) / BigInt(10_000 + feeBps) : undefined;

  return (
    <section className="rc-desk mk-desk" aria-label={mode === 1 ? "Eclipse order form" : "Quiet Book order form"}>
      <Segmented
        label="Side"
        value={side}
        onChange={(s) => {
          setSide(s);
          setAmt("");
        }}
        options={[
          { id: "buy", label: sym ? `Buy ${sym}` : "Buy" },
          { id: "sell", label: sym ? `Sell ${sym}` : "Sell" },
        ]}
      />
      <div className="rc-desk-body">
        {!fixed && markets.length > 1 ? (
          <div className="mk-pick">
            <label htmlFor={`mk-stock-${mode}`}>Stock</label>
            <select id={`mk-stock-${mode}`} value={sym} onChange={(e) => onSymbol?.(e.target.value)}>
              {markets.map((x) => (
                <option key={x.market} value={x.symbol}>
                  {x.name} ({x.symbol})
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <AmountField
          id={`mk-amount-${mode}`}
          label={sell ? "You sell" : "You pay"}
          unit={sell ? sym : "USDG"}
          value={amt}
          onChange={setAmt}
          max={maxIn !== undefined ? (sell ? amount(maxIn, { decimals: dec }) : usdg(maxIn)) : undefined}
          onMax={maxIn !== undefined ? () => setAmt(toInput(maxIn, sell ? dec : USDG_DECIMALS)) : undefined}
          hint={problem ? <span className="mk-problem" role="alert">{problem}</span> : sell ? (bal.asset !== undefined ? `Wallet balance: ${amount(bal.asset, { decimals: dec })} ${sym}` : null) : bal.usdg !== undefined ? `Wallet balance: ${usdg(bal.usdg)} USDG` : null}
        />

        {mode === 0 ? (
          <div className="rc-amount">
            <label htmlFor="mk-limit">Limit price</label>
            <div className="rc-amount-box">
              <input id="mk-limit" inputMode="decimal" autoComplete="off" placeholder="0.00" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} />
              <span className="rc-unit">USDG per {sym}</span>
            </div>
            <div className="rc-amount-foot">
              <span>{sell ? "Your floor. The order fills at this price or above." : "Your ceiling. The order fills at this price or below."}</span>
              {price ? (
                <button type="button" className="rc-max" onClick={() => setLimit(cents(pricePerToken(price, dec)))}>
                  Use {usd(pricePerToken(price, dec))}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mk-tol">
            <div className="rc-slip">
              <span>Price limit</span>
              {SWAP_TOLERANCE_BPS.map((b) => (
                <button key={b} type="button" aria-pressed={tol === b} onClick={() => setTol(b)}>
                  {bpsLabel(b)}
                </button>
              ))}
            </div>
            {poolNote ? (
              <p className="mk-tol-line mk-problem" role="status">
                {poolNote}
              </p>
            ) : poolListed ? (
              <p className="mk-tol-line">{`Whatever the batch leaves unmatched trades in the ${sym} Uniswap pool, no further than ${bpsLabel(maxDev ?? 0)} from the clearing price.`}</p>
            ) : null}
            {limitPrice !== undefined ? (
              <p className="mk-tol-line">
                Fills at{" "}
                <span className="mono">{usd(pricePerToken(limitPrice, dec))} USDG</span>
                {sell ? " or higher." : " or lower."}
              </p>
            ) : null}
          </div>
        )}

        <dl className="rc-rows rc-rows-tight">
          <Row label={`${sym || "Stock"} price now`} hint={m?.price?.updatedAt ? `Market price, updated ${ago(m.price.updatedAt, now)}` : undefined}>
            <Fig v={price ? usd(pricePerToken(price, dec)) : m && !m.price ? "Updating" : undefined} unit={price ? "USDG" : undefined} />
          </Row>
          <Row label="Estimated return at today's price">
            {estOut === undefined ? <span className="rc-muted-inline">Type an amount to see it</span> : <Fig v={sell ? usdg(estOut) : amount(estOut, { decimals: dec })} unit={sell ? "USDG" : sym} />}
          </Row>
          <Row label="Trading fee" hint={fees.discountBps > 0 ? `Your ORRY stake takes ${bpsLabel(fees.discountBps)} off` : undefined}>
            {payOrry && fees.orryReady ? (
              <Fig v={orryFeeEst !== undefined ? `${l3 === undefined ? "up to " : ""}${orry(orryFeeEst)}` : amountIn === undefined ? bpsLabel(effBps) : undefined} unit={orryFeeEst !== undefined ? "ORRY" : undefined} />
            ) : (
              <Fig v={feeUsdg !== undefined ? usdg(feeUsdg) : bpsLabel(effBps)} unit={feeUsdg !== undefined ? `USDG, ${bpsLabel(effBps)}` : undefined} />
            )}
          </Row>
          {orryWired ? (
            <Row label="Sealing fee" hint={sealFee && sealFee > 0n ? "Paid in ORRY and burned at sealing" : undefined}>
              <Fig v={sealFee === undefined ? undefined : sealFee === 0n ? "None" : orry(sealFee)} unit={sealFee && sealFee > 0n ? "ORRY" : undefined} />
            </Row>
          ) : null}
          <Row label="Batch" hint={phase ? (phase.inCommit ? `Clears after ${clock(phase.revealEnd)}` : `Opens in ${span(phase.left)}`) : undefined}>
            <Fig v={phase ? (phase.inCommit ? phase.batch : phase.batch + 1n).toLocaleString("en-US") : undefined} />
          </Row>
        </dl>

        {orryWired ? (
          <label className={`mk-check${fees.orryReady ? "" : " is-off"}`}>
            <input type="checkbox" checked={payOrry && Boolean(fees.orryReady)} disabled={!fees.orryReady} onChange={(e) => setPayOrry(e.target.checked)} />
            <span>
              Settle the trading fee in ORRY
              <small>
                {fees.orryReady === false
                  ? "Available as soon as the ORRY price is on record."
                  : l3 !== undefined
                    ? `Costs ${bpsLabel(l3)} less than paying in USDG. Every ORRY paid is burned.`
                    : "Every ORRY paid is burned."}
              </small>
            </span>
          </label>
        ) : null}

        {RELAY_ENABLED ? (
          <fieldset className="mk-reveal">
            <legend>Reveal</legend>
            <label>
              <input type="radio" name={`mk-reveal-${mode}`} checked={!byRelay} onChange={() => setByRelay(false)} />
              <span>
                I reveal it myself
                <small>When the reveal window opens, your wallet prompts you here. Leave this tab open until then.</small>
              </span>
            </label>
            <label>
              <input type="radio" name={`mk-reveal-${mode}`} checked={byRelay} onChange={() => setByRelay(true)} />
              <span>
                Orrery&apos;s relay reveals it
                <small>The relay gets the order at sealing and reveals it during the window, so this tab may close.</small>
              </span>
            </label>
          </fieldset>
        ) : null}

        <button type="button" className="primary rc-go" disabled={blocked} onClick={() => void onSeal()}>
          {label}
        </button>
        {closed ? <p className="rc-muted">Stock feeds move on US trading days. The next session takes new orders.</p> : null}
        {!ready ? (
          <div className="rc-connect">
            <p>{connected ? "Point your wallet at this network to place an order." : "Connect a wallet to place an order."}</p>
            <WalletButton />
          </div>
        ) : null}
        <NoticeLine notice={notice} />
        {fees.orryReady && fees.tiers.length > 0 && fees.discountBps === 0 ? (
          <p className="mk-desk-foot">
            A larger ORRY stake cuts this fee: {fees.tiers.map((t) => `${bpsLabel(t.discountBps)} off from ${usdg(t.minStakeUsd)} USD staked`).join(", ")}. <Link href="/stake">Stake ORRY</Link>
          </p>
        ) : null}
      </div>
    </section>
  );
}
