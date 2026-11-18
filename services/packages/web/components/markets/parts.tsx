"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { COMING_SOON } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import { amount, span } from "@/lib/orry/format";
import { MARKET_ROUTES } from "@/lib/markets/config";
import { phaseAt } from "@/lib/markets/chain";
import { usdg } from "@/lib/markets/math";
import type { StockLogo } from "@/lib/markets/logos";
import type { SealedOrder } from "@/lib/markets/store";
import { TxLink } from "../orry/parts";
import { useRuntime } from "./runtime";

/** Second row of navigation across the market pages. Held pages stay listed, marked "Coming soon". */
export function MarketTabs() {
  const path = usePathname();
  const releases = useReleases();
  return (
    <nav className="rc-tabs" aria-label="Markets">
      {MARKET_ROUTES.map((r) => {
        const live = !releases.ready || releases.isLive(r.feature);
        const current = path === r.href || path.startsWith(`${r.href}/`);
        return (
          <Link key={r.href} href={r.href} aria-current={current ? "page" : undefined} className={live ? undefined : "is-held"}>
            {r.label}
            {live ? null : <small>{COMING_SOON}</small>}
          </Link>
        );
      })}
    </nav>
  );
}

/** The company's official mark (lib/markets/logos.ts). Markets without one are filtered out before they reach a page. */
export function StockMark({ logo, size = 36 }: { logo: StockLogo; size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="mk-mark" src={logo.src} alt="" width={size} height={size} loading="lazy" decoding="async" />;
}

export const clock = (t: number) => `${new Date(t * 1000).toISOString().slice(11, 19)} UTC`;

/**
 * The batch clock: one bar for the commit window and one for the reveal window, with the current moment running
 * through them. Every market page uses it; its lengths come from the market itself.
 */
export function BatchClock({ start, commitSeconds, revealSeconds, now, sealed }: { start?: number; commitSeconds?: number; revealSeconds?: number; now: number; sealed?: number }) {
  const p = start && commitSeconds && revealSeconds ? phaseAt(now, start, commitSeconds, revealSeconds) : undefined;
  if (!p || !commitSeconds || !revealSeconds) {
    return (
      <div className="mk-clock is-wait" aria-label="Batch clock">
        <div className="mk-clock-head">
          <span>Batch</span>
          <strong>…</strong>
        </div>
        <div className="mk-bar" aria-hidden="true">
          <span style={{ flex: 4 }} />
          <span style={{ flex: 1 }} />
        </div>
      </div>
    );
  }
  const commitPct = p.inCommit ? ((now - p.commitStart) / commitSeconds) * 100 : 100;
  const revealPct = p.inCommit ? 0 : ((now - p.commitEnd) / revealSeconds) * 100;
  return (
    <div className="mk-clock" role="timer" aria-label={`Batch ${p.batch}, ${p.inCommit ? "sealing window" : "reveal window"} ends in ${span(p.left)}`}>
      <div className="mk-clock-head">
        <span>
          Batch <b className="mono">{p.batch.toLocaleString("en-US")}</b>
        </span>
        <strong>
          {p.inCommit ? "Sealing" : "Revealing"} <span className="mono">{span(p.left)}</span>
        </strong>
      </div>
      <div className="mk-bar" aria-hidden="true">
        <span className={p.inCommit ? "is-now" : "is-done"} style={{ flex: commitSeconds }}>
          <i style={{ width: `${Math.min(100, commitPct)}%` }} />
        </span>
        <span className={p.inCommit ? "" : "is-now"} style={{ flex: revealSeconds }}>
          <i style={{ width: `${Math.min(100, revealPct)}%` }} />
        </span>
      </div>
      <div className="mk-clock-foot">
        <span>Sealing closes {clock(p.commitEnd)}</span>
        <span>Reveal closes {clock(p.revealEnd)}, and the batch settles</span>
      </div>
      {sealed !== undefined && p.inCommit ? (
        <p className="mk-clock-count">{sealed === 0 ? "This batch holds no sealed orders yet." : sealed === 1 ? "This batch holds 1 sealed order." : `This batch holds ${sealed.toLocaleString("en-US")} sealed orders.`}</p>
      ) : null}
    </div>
  );
}

/** What an order says it trades: "Sell 2.5 TSLA" or "Buy TSLA with 500 USDG". */
export function orderTitle(o: { sellAsset: boolean; amountIn: bigint }, symbol: string, assetDecimals: number) {
  return o.sellAsset ? `Sell ${amount(o.amountIn, { decimals: assetDecimals })} ${symbol}` : `Buy ${symbol} with ${usdg(o.amountIn)} USDG`;
}

const STEPS = ["Sealed", "Revealed", "Cleared"] as const;
function stepOf(o: SealedOrder): number {
  if (o.state === "settled") return 2;
  if (o.state === "revealed") return 1;
  return 0;
}

/** Plain status of one sealed order, worded for the moment it is in. */
export function sealLine(o: SealedOrder, now: number): string {
  switch (o.state) {
    case "sealing":
      return "Approve the seal in your wallet.";
    case "sealed":
      if (o.relay) return now < o.revealEnd ? `Sealed. Orrery's relay will reveal it ${now < o.commitEnd ? `in ${span(o.commitEnd - now)}` : "now"}, so this tab may close.` : "Confirming the reveal on chain.";
      if (now < o.commitEnd) return `Sealed. In ${span(o.commitEnd - now)} your wallet prompts the reveal, so leave this tab open.`;
      if (now < o.revealEnd) return o.waitForClick ? `The reveal window has ${span(o.revealEnd - now)} to run.` : "Time to reveal. Approve it in your wallet.";
      return "The reveal window ended with this order still sealed. Your funds never left the wallet.";
    case "revealing":
      return "Approve the reveal in your wallet.";
    case "revealed":
      return now < o.revealEnd ? `Revealed. The batch settles in ${span(o.revealEnd - now)}.` : "Settling at the batch price.";
    case "missed":
      return "The reveal window ended with this order still sealed. Your funds never left the wallet.";
    case "settled": {
      const out = o.outcome;
      if (!out) return "Settled.";
      const sym = o.symbol;
      const got = o.order.sellAsset ? `${usdg(BigInt(out.output))} USDG` : `${amount(BigInt(out.output), { decimals: o.assetDecimals })} ${sym}`;
      if (out.status === "filled") return `Filled. You received ${got}.`;
      if (out.status === "partial") return `Partly filled. You received ${got}, and the remainder is still in your wallet.`;
      if (out.status === "expired") return "No price was on record when this batch closed. Your funds stayed put.";
      if (out.status === "dropped") return "This batch passed the order by. Your funds stayed put.";
      const kept = o.order.sellAsset ? sym : "USDG";
      if (out.status === "unfilled" && out.price === undefined) return `This batch made no trade. Your ${kept} stayed in your wallet.`;
      if (o.pooled) return `Not filled. No order crossed yours, and the ${sym} pool could not fill it inside the price band. Your ${kept} stayed in your wallet.`;
      return `Not filled. No order crossed yours at this price. Your ${kept} stayed in your wallet.`;
    }
  }
}

/** Three steps of a sealed order with the current one marked. */
export function SealTrack({ o }: { o: SealedOrder }) {
  const at = stepOf(o);
  return (
    <ol className="mk-track" aria-label="Order progress">
      {STEPS.map((s, i) => (
        <li key={s} className={i < at ? "is-done" : i === at ? "is-now" : undefined} aria-current={i === at ? "step" : undefined}>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** Live orders of this wallet across every market, pinned under the tabs while any is on its way. */
export function SealedStrip() {
  const rt = useRuntime();
  const live = rt.orders.filter((o) => o.state === "sealing" || o.state === "sealed" || o.state === "revealing" || o.state === "revealed");
  if (live.length === 0) return null;
  return (
    <section className="mk-strip" aria-label="Orders in flight" aria-live="polite">
      {live.map((o) => {
        const terms = { sellAsset: o.order.sellAsset, amountIn: BigInt(o.order.amountIn) };
        const canClick = o.state === "sealed" && o.waitForClick && rt.now >= o.commitEnd && rt.now < o.revealEnd;
        return (
          <div className="mk-strip-row" key={o.id}>
            <div className="mk-strip-copy">
              <strong>{orderTitle(terms, o.symbol, o.assetDecimals)}</strong>
              <span>
                Batch {o.batch}. {sealLine(o, rt.now)}
              </span>
            </div>
            <SealTrack o={o} />
            {canClick ? (
              <button type="button" className="primary" onClick={() => void rt.revealNow(o)} disabled={Boolean(rt.busy)}>
                Reveal now
              </button>
            ) : o.commitTx ? (
              <TxLink hash={o.commitTx} />
            ) : null}
          </div>
        );
      })}
      {rt.notice ? <p className={`mk-strip-note ${rt.notice.tone}`}>{rt.notice.text}</p> : null}
    </section>
  );
}
