"use client";

import { useState } from "react";
import { parseAbi, type Abi, type Address } from "viem";
import { useReadContract, useReadContracts, useSignTypedData } from "wagmi";
import { iLimitOrderBookAbi, LIMIT_ORDER_DOMAIN, LIMIT_ORDER_TYPES, type LimitOrderView } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { submitLimitOrder, useLimitOrders } from "@/lib/r2/api";
import { LIMIT_EXPIRY_DAYS, LIMIT_TIPS_BPS } from "@/lib/r2/config";
import { useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { amount, parseAmount, utc } from "@/lib/orry/format";
import { stockLogo } from "@/lib/markets/logos";
import { bpsLabel, usdg } from "@/lib/markets/math";
import { CHAIN_ID, USDG_DECIMALS } from "@/lib/config";
import { AmountField, Fig, NoticeLine, OrryHead, Row, Segmented } from "../orry/parts";
import { StockMark } from "../markets/parts";

const BOOK = ORRY.limitBook as Address;
const FACTORY = ORRY.marketFactory as Address;
const bookAbi = iLimitOrderBookAbi as Abi;
const factoryAbi = parseAbi(["function marketCount() view returns (uint256)", "function marketAt(uint256) view returns (address)"]);
const marketAbi = parseAbi([
  "function asset() view returns (address)",
  "function remainderPool() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool listed)",
]);
const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const E18 = 10n ** 18n;

interface Stock {
  asset: Address;
  symbol: string;
  name: string;
  decimals: number;
  price?: bigint; // USDG base units per 1e18 asset base units, from the book's oracle read
}

/** Stock tokens R1 lists with a pool, read from the R1 factory, with the book's fresh oracle price. */
function useStocks(): { stocks: Stock[]; loading: boolean } {
  const n = useReadContract({ address: FACTORY, abi: factoryAbi, functionName: "marketCount", query: { enabled: Boolean(FACTORY) } }).data;
  const markets = useReadContracts({
    contracts: Array.from({ length: Number(n ?? 0n) }, (_, i) => ({ address: FACTORY, abi: factoryAbi, functionName: "marketAt", args: [BigInt(i)] })),
    query: { enabled: n !== undefined },
  }).data?.map((r) => r.result as Address | undefined);
  const info = useReadContracts({
    contracts: (markets ?? []).flatMap((m) => [
      { address: m, abi: marketAbi, functionName: "asset" },
      { address: m, abi: marketAbi, functionName: "remainderPool" },
    ]),
    query: { enabled: Boolean(markets?.length) },
  }).data;
  const assets = (markets ?? [])
    .map((_, i) => ({ asset: info?.[i * 2]?.result as Address | undefined, listed: (info?.[i * 2 + 1]?.result as readonly [unknown, boolean] | undefined)?.[1] }))
    .filter((a): a is { asset: Address; listed: true } => Boolean(a.asset && a.listed));
  const meta = useReadContracts({
    contracts: assets.flatMap((a) => [
      { address: a.asset, abi: tokenAbi, functionName: "symbol" },
      { address: a.asset, abi: tokenAbi, functionName: "name" },
      { address: a.asset, abi: tokenAbi, functionName: "decimals" },
      { address: BOOK, abi: bookAbi, functionName: "oraclePrice", args: [a.asset] },
    ]),
    query: { enabled: assets.length > 0, refetchInterval: 15_000 },
  }).data;
  const stocks = assets
    .map((a, i) => ({
      asset: a.asset,
      symbol: String(meta?.[i * 4]?.result ?? ""),
      name: String(meta?.[i * 4 + 1]?.result ?? ""),
      decimals: Number(meta?.[i * 4 + 2]?.result ?? 18),
      price: meta?.[i * 4 + 3]?.status === "success" ? (meta[i * 4 + 3]!.result as bigint) : undefined,
    }))
    // owner rule: a stock is listed only with its official mark
    .filter((s) => s.symbol && stockLogo(CHAIN_ID, s.asset, s.symbol));
  return { stocks, loading: n === undefined || (assets.length > 0 && !meta) };
}

const perShare = (price: bigint, decimals: number) => (price * 10n ** BigInt(decimals)) / E18;
const priceIn = (s: string, decimals: number) => {
  const v = parseAmount(s, USDG_DECIMALS);
  return v ? (v * E18) / 10n ** BigInt(decimals) : undefined;
};

function OrderDesk({ stocks }: { stocks: Stock[] }) {
  const { address, ready } = useWallet();
  const tx = useTx();
  const sign = useSignTypedData();
  const [pick, setPick] = useState<Address | undefined>(undefined);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [limit, setLimit] = useState("");
  const [tip, setTip] = useState<number>(LIMIT_TIPS_BPS[1]);
  const [days, setDays] = useState<number>(LIMIT_EXPIRY_DAYS[1]);
  const [inOrry, setInOrry] = useState(false);
  const stock = stocks.find((s) => s.asset === pick) ?? stocks[0];
  const usdgAddr = useReadContract({ address: BOOK, abi: bookAbi, functionName: "usdg", query: { staleTime: Infinity } }).data as Address | undefined;
  const feeBps = Number(useReadContract({ address: BOOK, abi: bookAbi, functionName: "feeBps", query: { staleTime: Infinity } }).data ?? 0);
  const devBps = Number(useReadContract({ address: BOOK, abi: bookAbi, functionName: "maxDeviationBps", query: { staleTime: Infinity } }).data ?? 0);
  if (!stock) return null;

  const sell = side === "sell";
  const amountIn = parseAmount(amt, sell ? stock.decimals : USDG_DECIMALS);
  const limitPrice = priceIn(limit, stock.decimals);
  const notional = amountIn && limitPrice ? (sell ? (amountIn * limitPrice) / E18 : amountIn) : undefined;
  const fee = notional !== undefined ? (notional * BigInt(feeBps)) / 10_000n : undefined;
  const tipAmt = notional !== undefined ? (notional * BigInt(tip)) / 10_000n : undefined;

  async function place() {
    if (!address || !amountIn || !limitPrice || !usdgAddr || fee === undefined || tipAmt === undefined) return;
    const tokenIn = sell ? stock!.asset : usdgAddr;
    const need = sell ? amountIn : amountIn + (inOrry ? 0n : fee) + tipAmt;
    await tx.run("Place order", async ({ send, step, ensureAllowance }) => {
      step(`Approve the ${sell ? stock!.symbol : "USDG"} spend for the order book in your wallet.`);
      await send({ address: tokenIn, abi: tokenAbi as Abi, functionName: "approve", args: [BOOK, need] });
      if (inOrry) await ensureAllowance(address, BOOK, 10n ** 24n, step);
      const nonce = BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`);
      const expiry = Math.floor(Date.now() / 1000) + days * 86_400;
      const message = { owner: address, asset: stock!.asset, sellAsset: sell, amountIn, limitPrice, tipBps: tip, payFeeInOrry: inOrry, nonce, expiry: BigInt(expiry) };
      step("Sign the order message in your wallet. Your tokens stay put until a fill.");
      const signature = await sign.mutateAsync({
        domain: { ...LIMIT_ORDER_DOMAIN, chainId: CHAIN_ID, verifyingContract: BOOK },
        types: LIMIT_ORDER_TYPES,
        primaryType: "Order",
        message,
      });
      await submitLimitOrder({
        owner: address,
        asset: stock!.asset,
        sellAsset: sell,
        amountIn: amountIn.toString(),
        limitPrice: limitPrice.toString(),
        tipBps: tip,
        payFeeInOrry: inOrry,
        nonce: nonce.toString(),
        expiry,
        signature,
      });
      setAmt("");
      return `Order on record: ${sell ? "sell" : "buy"} ${stock!.symbol}, limit ${limit} USD. A keeper fills it when the pool meets your price.`;
    });
  }

  return (
    <section className="rc-desk r2-desk" aria-label="Limit order desk">
      <div className="mk-pick">
        <label htmlFor="limit-stock">Stock</label>
        <select id="limit-stock" value={stock.asset} onChange={(e) => setPick(e.target.value as Address)}>
          {stocks.map((s) => (
            <option key={s.asset} value={s.asset}>
              {s.symbol}, {s.name}
            </option>
          ))}
        </select>
      </div>
      <p className="r2-quote">
        {stock.price !== undefined ? (
          <>
            Market price <b className="mono">{usdg(perShare(stock.price, stock.decimals))}</b> USD per share. Fills happen within {bpsLabel(devBps)} of it.
          </>
        ) : (
          "Fills resume when the next US session opens."
        )}
      </p>
      <div className="rc-desk-body">
        <Segmented label="Side" value={side} onChange={setSide} options={[{ id: "buy", label: "Buy" }, { id: "sell", label: "Sell" }]} />
        <AmountField id="limit-amt" label={sell ? `Sell amount, ${stock.symbol}` : "Spend amount, USDG"} unit={sell ? stock.symbol : "USDG"} value={amt} onChange={setAmt} />
        <AmountField id="limit-price" label={sell ? "Minimum price per share" : "Maximum price per share"} unit="USD" value={limit} onChange={setLimit} />
        <div className="r2-choices">
          <span>Keeper tip</span>
          {LIMIT_TIPS_BPS.map((b) => (
            <button key={b} type="button" aria-pressed={tip === b} onClick={() => setTip(b)}>
              {b === 0 ? "None" : bpsLabel(b)}
            </button>
          ))}
        </div>
        <div className="r2-choices">
          <span>Valid for</span>
          {LIMIT_EXPIRY_DAYS.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
              {d === 1 ? "1 day" : `${d} days`}
            </button>
          ))}
        </div>
        {/* Paying in ORRY is offered only once ORRY exists (USDG-only until then). */}
        {ORRY.token ? (
          <label className="r2-check">
            <input type="checkbox" checked={inOrry} onChange={(e) => setInOrry(e.target.checked)} /> Settle the fee in ORRY for 25% less
          </label>
        ) : null}
        <dl className="rc-rows rc-rows-tight">
          <Row label={`Fee, ${bpsLabel(feeBps)}`}>{fee !== undefined ? (inOrry ? "Charged in ORRY on fill" : `${usdg(fee)} USDG`) : "…"}</Row>
          <Row label="Keeper tip">{tipAmt !== undefined ? `${usdg(tipAmt)} USDG` : "…"}</Row>
          <Row label={sell ? "Proceeds at your price" : "Needed in your wallet"}>
            {notional !== undefined && fee !== undefined && tipAmt !== undefined
              ? sell
                ? `At least ${usdg(notional - (inOrry ? 0n : fee) - tipAmt)} USDG`
                : `${usdg(notional + (inOrry ? 0n : fee) + tipAmt)} USDG in total`
              : "…"}
          </Row>
        </dl>
        {ready ? (
          <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !amountIn || !limitPrice} onClick={() => void place()}>
            {tx.busy ? "Placing…" : sell ? "Sign the sell order" : "Sign the buy order"}
          </button>
        ) : (
          <WalletButton />
        )}
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}

const STATUS: Record<LimitOrderView["status"], string> = { open: "Watching for your price", filled: "Filled", cancelled: "Cancelled", expired: "Expired" };

function MyOrders({ stocks }: { stocks: Stock[] }) {
  const { address } = useWallet();
  const q = useLimitOrders(address, Boolean(address));
  const tx = useTx();
  const orders = q.data?.orders ?? [];
  if (!address || orders.length === 0) return null;
  const dec = (asset: string) => stocks.find((s) => s.asset.toLowerCase() === asset)?.decimals ?? 18;
  return (
    <section className="rc-panel" aria-label="Limit orders on record">
      <div className="rc-panel-head">
        <h2>Your orders</h2>
      </div>
      <table className="rc-table">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col" className="num">Price</th>
            <th scope="col">Valid until</th>
            <th scope="col">Status</th>
            <th scope="col"><span className="sr-only">Cancel</span></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const d = dec(o.asset);
            return (
              <tr key={o.hash}>
                <td data-label="Order">
                  {o.sellAsset ? `Sell ${amount(BigInt(o.amountIn), { decimals: d })} ${o.symbol}` : `Buy ${o.symbol} for ${usdg(BigInt(o.amountIn))} USDG`}
                </td>
                <td data-label="Price" className="num mono">{usdg(perShare(BigInt(o.limitPrice), d))}</td>
                <td data-label="Valid until">{utc(o.expiry)}</td>
                <td data-label="Status">
                  {STATUS[o.status]}
                  {o.fill ? <small className="mk-sub">{o.sellAsset ? `${usdg(BigInt(o.fill.amountOut))} USDG` : `${amount(BigInt(o.fill.amountOut), { decimals: d })} ${o.symbol}`}</small> : null}
                </td>
                <td>
                  {o.status === "open" ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={Boolean(tx.busy)}
                      onClick={() => void tx.run("Cancel", async ({ send }) => {
                        await send({ address: BOOK, abi: bookAbi, functionName: "cancel", args: [BigInt(o.nonce)] });
                        return "Cancelled on chain, so this order is now off the book.";
                      })}
                    >
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <NoticeLine notice={tx.notice} />
    </section>
  );
}

/** Held page: stored orders stay visible and cancellable whatever the release switch says. */
export function LimitExits() {
  return <MyOrders stocks={useStocks().stocks} />;
}

export function LimitOrdersView() {
  const { stocks, loading } = useStocks();
  return (
    <>
      <OrryHead
        title="Set your price. Your tokens stay with you until the fill."
        lead={<p>Pick a stock token and sign a buy or sell order. When the pool meets your price, near the market price, a keeper fills it through that token&apos;s pool. Your tokens leave your wallet only in that one transaction.</p>}
        reading={
          <div className="rc-card">
            <p className="rc-card-title">Stocks open to limit orders</p>
            <p className="rc-big">
              <Fig v={loading ? undefined : stocks.length.toLocaleString("en-US")} unit={stocks.length === 1 ? "stock token" : "stock tokens"} />
            </p>
            <div className="r2-marks">
              {stocks.slice(0, 8).map((s) => {
                const logo = stockLogo(CHAIN_ID, s.asset, s.symbol);
                return logo ? <StockMark key={s.asset} logo={logo} size={28} /> : null;
              })}
            </div>
          </div>
        }
      />
      <div className="rc-grid">
        {stocks.length ? <OrderDesk stocks={stocks} /> : <p className="rc-muted">{loading ? "Loading stocks…" : "Each stock token shows here as soon as its pool is listed."}</p>}
      </div>
      <MyOrders stocks={stocks} />
    </>
  );
}

