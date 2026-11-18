"use client";

import { useMemo, useState } from "react";
import { erc20Abi, keccak256, toBytes, type Abi, type Address, type Hex } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { BOOST_KINDS, orryBoostAbi, templateMarketAbi, type CommunityTemplate } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { NoticeLine, OrryHead, Row } from "@/components/orry/parts";
import { USDG_DECIMALS } from "@/lib/config";
import { useTemplates } from "@/lib/community/api";
import { useCommunity, type CommunityConfig } from "@/lib/community/config";
import { bpsOf, percent, sameAddr, usd, withHeadroom } from "@/lib/community/logic";
import { useCommunityTx, type Run } from "@/lib/community/tx";
import { big, time } from "@/lib/orry/api";
import { useNow, useWallet } from "@/lib/orry/chain";
import { mask, parseAmount, orry, span } from "@/lib/orry/format";

const marketAbi = templateMarketAbi as Abi;
const boostAbi = orryBoostAbi as Abi;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function TemplatesView() {
  const { config, live } = useCommunity();
  if (!config) return null;
  return <Templates cfg={config} boostOpen={live("burn-to-boost")} />;
}

function Templates({ cfg, boostOpen }: { cfg: CommunityConfig; boostOpen: boolean }) {
  const { address, ready, connected } = useWallet();
  const q = useTemplates(true);
  const now = useNow(5000);
  const tx = useCommunityTx();
  const [actedOn, setActedOn] = useState<number | null>(null);
  const market = cfg.addresses.templates as Address;
  // USDG-only mode: `TemplateMarketUsdg` charges USDG, sends the fee to the treasury and the rest to the creator
  const usdgMode = cfg.templatePayment === "usdg";
  const asset = cfg.templateAsset;
  const balance = useReadContract({ address: asset ?? undefined, abi: erc20Abi, functionName: "balanceOf", args: [address ?? ZERO], query: { enabled: Boolean(usdgMode && asset && address), refetchInterval: 30_000 } });
  const all = useMemo(() => q.data?.templates ?? [], [q.data]);
  const boostedUntil = (t: CommunityTemplate) => (t.boostedUntil ? time(t.boostedUntil) : 0);
  // Boosted listings first, then the market's order.
  const listed = all.filter((t) => t.listed).sort((a, b) => Number(boostedUntil(b) > now) - Number(boostedUntil(a) > now));
  const mine = all.filter((t) => sameAddr(t.creator, address));

  const reads = useReadContracts({
    allowFailure: true,
    contracts: listed.flatMap((t) => [
      { address: market, abi: templateMarketAbi, functionName: "quote" as const, args: [BigInt(t.id)] as const },
      { address: market, abi: templateMarketAbi, functionName: "licensed" as const, args: [BigInt(t.id), address ?? ZERO] as const },
    ]),
    query: { enabled: listed.length > 0, refetchInterval: 30_000 },
  });
  const quoteOf = (i: number) => (reads.data?.[i * 2]?.status === "success" ? (reads.data[i * 2]!.result as bigint) : undefined);
  const licensedOf = (i: number) => Boolean(address && reads.data?.[i * 2 + 1]?.status === "success" && reads.data[i * 2 + 1]!.result);

  async function buy(t: CommunityTemplate, quote: bigint) {
    // a USDG price is exact (the buyer pays at most what the page shows); an ORRY quote moves with the price
    const max = usdgMode ? quote : withHeadroom(quote);
    setActedOn(t.id);
    await tx.run("Buy template", async ({ send, step, approve }) => {
      if (usdgMode) await approve(asset as Address, market, max, "USDG");
      else await approve(cfg.addresses.orry as Address, market, max);
      step("Sign the purchase in your wallet.");
      await send({ address: market, abi: marketAbi, functionName: "buy", args: [BigInt(t.id), max] });
      return `Licence on record. Template ${t.id} now belongs to this wallet.`;
    });
  }

  return (
    <>
      <OrryHead
        title="Orbits other operators have already charted."
        lead={
          <p>
            {usdgMode
              ? `Ready-made policies that set an agent's caps and allowed targets. Prices and payment are in USDG. Each sale pays ${percent(10_000 - cfg.templateFeeBps)} to the creator and ${percent(cfg.templateFeeBps)} to Orrery.`
              : `Ready-made policies that set an agent's caps and allowed targets. Prices are in USD, payment is in ORRY, ${percent(cfg.templateBurnBps)} of every sale is burned and the creator keeps the remainder.`}
          </p>
        }
      />
      <section className="rc-panel rc-board" aria-label="Templates">
        <div className="rc-panel-head">
          <h2>Templates</h2>
          <p>A licence stays with the wallet that bought it. Compare the content hash with the hosted file before buying.</p>
        </div>
        {q.isLoading ? (
          <p className="rc-muted">…</p>
        ) : listed.length === 0 ? (
          <p className="rc-muted">{q.isError ? "Listings load in a moment." : "Listings are added here as creators publish them."}</p>
        ) : (
          <table className="rc-table cm-templates">
            <thead>
              <tr>
                <th scope="col">Template</th>
                <th scope="col">Creator</th>
                <th scope="col" className="num">Price</th>
                <th scope="col" className="num">Sales</th>
                <th scope="col" className="num">
                  <span className="cm-sr">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {listed.map((t, i) => {
                const quote = quoteOf(i);
                const own = sameAddr(t.creator, address);
                const licensed = licensedOf(i);
                const until = boostedUntil(t);
                const short = usdgMode && quote !== undefined && balance.data !== undefined && balance.data < quote;
                return (
                  <tr key={t.id}>
                    <td>
                      <strong className="cm-tpl-name">Template {t.id}</strong>
                      {until > now ? <span className="cm-boosted">Boost · {span(until - now)} to go</span> : null}
                      <TemplateLinks t={t} />
                    </td>
                    <td className="mono" data-label="Creator">
                      {own ? "You" : mask(t.creator)}
                    </td>
                    <td className="num" data-label="Price">
                      {/* a USDG quote is the stored price itself: show it live so a reprice shows before the indexer catches up */}
                      <span className="mono">{usd(usdgMode && quote !== undefined ? quote : big(t.priceUsd))}</span>
                      <small className="cm-sub mono">
                        {quote === undefined ? "…" : usdgMode ? `${usd(quote - bpsOf(quote, cfg.templateFeeBps))} to the creator` : `${orry(quote)} ORRY today`}
                      </small>
                    </td>
                    <td className="num mono" data-label="Sales">
                      {t.sales.toLocaleString("en-US")}
                    </td>
                    <td className="num">
                      {own ? (
                        <span className="cm-state">Yours</span>
                      ) : licensed ? (
                        <span className="cm-state">Licensed</span>
                      ) : connected ? (
                        <>
                          <button className="secondary" type="button" disabled={!ready || Boolean(tx.busy) || quote === undefined || short} onClick={() => quote !== undefined && void buy(t, quote)}>
                            {tx.busy && actedOn === t.id ? "Buying…" : "Buy"}
                          </button>
                          {short ? <small className="cm-sub">Needs {usd(quote!)} USDG in this wallet.</small> : null}
                        </>
                      ) : null}
                      {actedOn === t.id ? <NoticeLine notice={tx.notice} /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!connected && listed.length > 0 ? (
          <div className="rc-connect">
            <p>Buying a template needs a connected wallet.</p>
            <WalletButton />
          </div>
        ) : null}
      </section>
      <div className="rc-grid cm-after">
        <ListForm cfg={cfg} usdgMode={usdgMode} />
        <section className="rc-side" aria-label="Your templates">
          <h2>Your templates</h2>
          {!address ? (
            <p className="rc-muted">Connect a wallet to see the templates it has listed.</p>
          ) : mine.length === 0 ? (
            <p className="rc-muted">{q.isLoading ? "…" : "This wallet has not listed a template."}</p>
          ) : (
            <ul className="cm-mine">
              {mine.map((t) => (
                <MyTemplate key={t.id} cfg={cfg} t={t} boostOpen={boostOpen} run={tx.run} busy={Boolean(tx.busy)} onAct={() => setActedOn(t.id)} notice={actedOn === t.id ? tx.notice : null} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function TemplateLinks({ t }: { t: CommunityTemplate }) {
  const href = /^https?:\/\//i.test(t.uri) ? t.uri : undefined;
  return (
    <span className="cm-sub">
      {href ? (
        <a className="cm-link" href={href} target="_blank" rel="noreferrer">
          Open file
        </a>
      ) : t.uri ? (
        <span className="mono">{t.uri}</span>
      ) : null}
      <span className="mono" title={t.contentHash}>
        {shortHash(t.contentHash)}
      </span>
    </span>
  );
}

/** List a template: USD price within the market's range, the content hash of the policy JSON, and where the file lives. */
function ListForm({ cfg, usdgMode }: { cfg: CommunityConfig; usdgMode: boolean }) {
  const { ready, connected } = useWallet();
  const tx = useCommunityTx();
  const market = cfg.addresses.templates as Address;
  const bounds = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: market, abi: templateMarketAbi, functionName: "minPriceUsd" },
      { address: market, abi: templateMarketAbi, functionName: "maxPriceUsd" },
    ],
    query: { staleTime: Infinity },
  });
  const min = bounds.data?.[0]?.status === "success" ? (bounds.data[0].result as bigint) : undefined;
  const max = bounds.data?.[1]?.status === "success" ? (bounds.data[1].result as bigint) : undefined;
  const [priceIn, setPriceIn] = useState("");
  const [json, setJson] = useState("");
  const [uri, setUri] = useState("");
  const price = parseAmount(priceIn, USDG_DECIMALS);
  const inRange = price !== undefined && (min === undefined || price >= min) && (max === undefined || price <= max);
  const parsed = useMemo(() => {
    if (!json.trim()) return undefined;
    try {
      JSON.parse(json);
      return keccak256(toBytes(json)) as Hex;
    } catch {
      return null;
    }
  }, [json]);

  async function list() {
    if (!price || !parsed || !uri.trim()) return;
    const u = uri.trim();
    await tx.run("List template", async ({ send }) => {
      await send({ address: market, abi: marketAbi, functionName: "list", args: [price, parsed, u] });
      setPriceIn("");
      setJson("");
      setUri("");
      return "Listing on record. The market shows it shortly.";
    });
  }

  return (
    <section className="rc-desk" aria-label="New listing">
      <div className="rc-desk-body">
        <h2 className="cm-desk-title">New listing</h2>
        <div className="rc-amount">
          <label htmlFor="cm-tpl-price">Licence price</label>
          <div className="rc-amount-box">
            <input id="cm-tpl-price" inputMode="decimal" autoComplete="off" placeholder="0.00" value={priceIn} onChange={(e) => setPriceIn(e.target.value.replace(/[^\d.]/g, ""))} />
            <span className="rc-unit">{usdgMode ? "USDG" : "USD"}</span>
          </div>
          <div className="rc-amount-foot">
            <span>
              {min !== undefined && max !== undefined ? `Between ${usd(min)} and ${usd(max)}. ` : ""}
              {usdgMode ? `Buyers pay in USDG and ${percent(10_000 - cfg.templateFeeBps)} of each sale reaches this wallet.` : "Paid in ORRY at the current rate."}
            </span>
          </div>
        </div>
        <div>
          <label className="cm-label" htmlFor="cm-tpl-json">
            Policy JSON
          </label>
          <textarea id="cm-tpl-json" className="cm-code" rows={6} spellCheck={false} placeholder='{ "caps": [] }' value={json} onChange={(e) => setJson(e.target.value)} />
          <p className="cm-field-foot">{parsed === null ? "The JSON does not parse." : parsed ? <span className="mono">Content hash {shortHash(parsed)}</span> : "Paste the file exactly as hosted. The listing stores its keccak256 hash."}</p>
        </div>
        <div>
          <label className="cm-label" htmlFor="cm-tpl-uri">
            File address
          </label>
          <input id="cm-tpl-uri" className="cm-input" autoComplete="off" spellCheck={false} placeholder="https:// or ipfs://" value={uri} onChange={(e) => setUri(e.target.value)} />
        </div>
        {connected ? (
          <button className="primary rc-go" type="button" disabled={!ready || Boolean(tx.busy) || !inRange || !parsed || !uri.trim()} onClick={() => void list()}>
            {tx.busy ? "Listing…" : "List template"}
          </button>
        ) : (
          <div className="rc-connect">
            <p>Listing a template needs a connected wallet.</p>
            <WalletButton />
          </div>
        )}
        <NoticeLine notice={tx.notice} />
      </div>
    </section>
  );
}

/** One of the creator's templates: reprice, delist or relist, and boost the listing for 24 hours. */
function MyTemplate({ cfg, t, boostOpen, run, busy, onAct, notice }: { cfg: CommunityConfig; t: CommunityTemplate; boostOpen: boolean; run: Run; busy: boolean; onAct: () => void; notice: ReturnType<typeof useCommunityTx>["notice"] }) {
  const { ready } = useWallet();
  const market = cfg.addresses.templates as Address;
  const boost = cfg.addresses.boost;
  const unit = cfg.templatePayment === "usdg" ? "USDG" : "USD";
  const [priceIn, setPriceIn] = useState("");
  const price = parseAmount(priceIn, USDG_DECIMALS);
  const boostQuote = useReadContract({ address: boost ?? undefined, abi: orryBoostAbi, functionName: "quote", args: [BOOST_KINDS.template, 1n], query: { enabled: Boolean(boost && boostOpen && t.listed), refetchInterval: 30_000 } });

  async function reprice() {
    if (!price) return;
    onAct();
    await run("Reprice", async ({ send }) => {
      await send({ address: market, abi: marketAbi, functionName: "setPrice", args: [BigInt(t.id), price] });
      setPriceIn("");
      return `New price on record · template ${t.id} at ${usd(price)}.`;
    });
  }
  async function setListed(listed: boolean) {
    onAct();
    await run(listed ? "Relist" : "Delist", async ({ send }) => {
      await send({ address: market, abi: marketAbi, functionName: "setListed", args: [BigInt(t.id), listed] });
      return listed ? `Template ${t.id} is back on the shelf.` : `Template ${t.id} is off the shelf. Every licence sold so far stays with its holder.`;
    });
  }
  async function boostIt() {
    if (!boost || boostQuote.data === undefined) return;
    const max = withHeadroom(boostQuote.data);
    onAct();
    await run("Boost", async ({ send, step, approve }) => {
      await approve(cfg.addresses.orry as Address, boost, max);
      step("Sign the boost in your wallet.");
      await send({ address: boost, abi: boostAbi, functionName: "boost", args: [BOOST_KINDS.template, BigInt(t.id), 1n, max] });
      return `Template ${t.id} sits at the top for 24 hours. The ORRY spent on the boost is burned.`;
    });
  }

  return (
    <li className="rc-agent">
      <div className="rc-agent-head">
        <strong>Template {t.id}</strong>
        <span>{t.listed ? `Listed at ${usd(big(t.priceUsd))} · ${t.sales.toLocaleString("en-US")} sold` : `Off the shelf · ${t.sales.toLocaleString("en-US")} sold`}</span>
      </div>
      <dl className="rc-rows rc-rows-tight">
        <Row label="Content hash">
          <span title={t.contentHash}>{shortHash(t.contentHash)}</span>
        </Row>
      </dl>
      <div className="rc-agent-actions">
        <div className="rc-inline">
          <input aria-label={`Template ${t.id} price in ${unit}`} inputMode="decimal" autoComplete="off" placeholder={`Price in ${unit}`} value={priceIn} onChange={(e) => setPriceIn(e.target.value.replace(/[^\d.]/g, ""))} />
          <button className="secondary" type="button" disabled={!ready || busy || !price} onClick={() => void reprice()}>
            Reprice
          </button>
        </div>
        <button className="secondary" type="button" disabled={!ready || busy} onClick={() => void setListed(!t.listed)}>
          {t.listed ? "Delist" : "Relist"}
        </button>
        {boostOpen && boost && t.listed ? (
          <button className="secondary" type="button" disabled={!ready || busy || boostQuote.data === undefined} onClick={() => void boostIt()}>
            Boost 24 h{boostQuote.data !== undefined ? ` · ${orry(boostQuote.data)} ORRY` : ""}
          </button>
        ) : null}
      </div>
      <NoticeLine notice={notice} />
    </li>
  );
}
