"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useWallet } from "@/lib/orry/chain";
import { EXPLORER_URL } from "@/lib/orry/config";
import { mask, period } from "@/lib/orry/format";
import type { Market } from "@/lib/markets/api";
import { useBatches } from "@/lib/markets/api";
import { useFeeView, useMarketChain } from "@/lib/markets/chain";
import { bpsLabel, usdg } from "@/lib/markets/math";
import { Fig, Row } from "../orry/parts";
import { BatchClock } from "./parts";
import { useRuntime } from "./runtime";

/**
 * The market a page opens on when the address names none. The API lists the newest market first, and a market without
 * a Uniswap pool fills a lone order only against another order in the same batch, so the page opens on a widely held
 * stock that has a pool.
 */
const PREFERRED = ["NVDA", "AAPL", "SPY"];
function defaultMarket(markets: Market[]): Market | undefined {
  for (const s of PREFERRED) {
    const m = markets.find((x) => x.symbol.toUpperCase() === s && x.poolListed);
    if (m) return m;
  }
  return markets.find((x) => x.poolListed) ?? markets[0];
}

/** The stock in view, kept in the address bar as ?stock=SYMBOL so a link opens the same market. */
export function useMarketPick(markets: Market[]) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const want = params.get("stock")?.toUpperCase();
  const m = markets.find((x) => x.symbol.toUpperCase() === want) ?? defaultMarket(markets);
  const pick = (symbol: string) => router.replace(`${path}?stock=${encodeURIComponent(symbol)}`, { scroll: false });
  return { m, pick };
}

/** Batch clock of one market, with the live count of sealed orders from the API. */
export function MarketClock({ m, skew = 0 }: { m: Market; skew?: number }) {
  const rt = useRuntime();
  const cfg = useMarketChain(m.market);
  const batches = useBatches(m.market, 3);
  const open = batches.data?.find((b) => b.status === "commit");
  return <BatchClock start={cfg.start ?? m.params.start} commitSeconds={cfg.commitSeconds ?? m.params.commitSeconds} revealSeconds={cfg.revealSeconds ?? m.params.revealSeconds} now={rt.now + skew} sealed={open?.commits} />;
}

/** The market's own settings and the fee tiers that ORRY stake unlocks. */
export function MarketFacts({ m }: { m: Market }) {
  const { address } = useWallet();
  const cfg = useMarketChain(m.market);
  const fees = useFeeView(cfg, address);
  const cs = cfg.commitSeconds ?? m.params.commitSeconds;
  const rs = cfg.revealSeconds ?? m.params.revealSeconds;
  const feeBps = cfg.feeBps ?? m.params.feeBps;
  const min = cfg.minNotionalUsdg ?? m.params.minNotionalUsdg;
  // Tiers are USD thresholds (R-44, R-46); with the ORRY price not ready every discount is 0, so none is shown.
  const active = fees.orryReady === true;
  const current = active ? fees.tiers.filter((t) => fees.stakeUsd !== undefined && fees.stakeUsd >= t.minStakeUsd).pop() : undefined;
  return (
    <div className="mk-facts">
      <dl className="rc-rows">
        <Row label="Batch" hint={cs && rs ? `Sealing ${period(cs)}, then reveal ${period(rs)}` : undefined}>
          <Fig v={cs && rs ? period(cs + rs) : undefined} />
        </Row>
        <Row label="Trading fee" hint="Charged on the filled amount, both sides">
          <Fig v={feeBps !== undefined ? bpsLabel(feeBps) : undefined} />
        </Row>
        {(cfg.poolListed ?? m.poolListed) !== undefined ? (
          <Row label="Swap orders left unmatched" hint={(cfg.poolListed ?? m.poolListed) ? `No further than ${bpsLabel(cfg.maxDeviationBps ?? m.params.maxDeviationBps ?? 0)} from the clearing price` : undefined}>
            <span className="rc-muted-inline">{(cfg.poolListed ?? m.poolListed) ? "Trade in the Uniswap pool" : "Remain with you"}</span>
          </Row>
        ) : null}
        <Row label="Smallest order">
          <Fig v={min !== undefined ? usdg(min) : undefined} unit="USDG" />
        </Row>
        <Row label="Token">
          {EXPLORER_URL ? (
            <a className="mono rc-tx" href={`${EXPLORER_URL}/token/${m.asset}`} target="_blank" rel="noreferrer">
              {mask(m.asset)}
            </a>
          ) : (
            <span className="mono">{mask(m.asset)}</span>
          )}
        </Row>
      </dl>
      {fees.tiers.length > 0 && active ? (
        <div className="mk-tiers">
          <h3>Lower fees for staked ORRY</h3>
          <ul>
            {fees.tiers.map((t) => (
              <li key={t.minStakeUsd.toString()} className={current === t ? "is-yours" : undefined}>
                <span>From {usdg(t.minStakeUsd)} USD staked</span>
                <strong>{bpsLabel(t.discountBps)} off</strong>
              </li>
            ))}
          </ul>
          <p className="rc-muted">
            {address && fees.stakeUsd !== undefined ? `Your ORRY stake reads ${usdg(fees.stakeUsd)} USD${current ? `, which takes ${bpsLabel(current.discountBps)} off your fee.` : "."} ` : ""}
            <Link href="/stake">Stake ORRY</Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}
