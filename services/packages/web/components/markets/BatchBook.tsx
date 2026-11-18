"use client";

import { useState } from "react";
import { amount, ago, mask } from "@/lib/orry/format";
import { useBatchDetail, useBatches, type BatchStatus, type Market } from "@/lib/markets/api";
import { phaseAt, useBatchChain, useMarketChain } from "@/lib/markets/chain";
import { pricePerToken, usd, usdg } from "@/lib/markets/math";
import { Fig, Row, TxLink } from "../orry/parts";
import { useRuntime } from "./runtime";

const STATUS: Record<BatchStatus, string> = {
  commit: "Sealing",
  reveal: "Revealing",
  clearing: "Clearing",
  cleared: "Cleared",
  expired: "No price on record",
};
const FILL: Record<string, string> = { filled: "Filled", partial: "Partly filled", unfilled: "No match", dropped: "Not settled", revealed: "Awaiting settlement", expired: "No price on record" };

/**
 * The revealed book of one batch after its reveal window, its clearing result, and the market's recent batches.
 * Orders and the result are read from the market contract; per-order fills come from the API.
 */
export function BatchBook({ m }: { m: Market }) {
  const rt = useRuntime();
  const cfg = useMarketChain(m.market);
  const start = cfg.start ?? m.params.start;
  const cs = cfg.commitSeconds ?? m.params.commitSeconds;
  const rs = cfg.revealSeconds ?? m.params.revealSeconds;
  const phase = start && cs && rs ? phaseAt(rt.now, start, cs, rs) : undefined;
  const batches = useBatches(m.market, 12);
  const past = (batches.data ?? []).filter((b) => b.revealEndsAt <= rt.now);
  const latestWithOrders = past.find((b) => b.reveals > 0)?.batch;
  const fallback = phase && phase.batch > 0n ? phase.batch - 1n : undefined;
  const [picked, setPicked] = useState<bigint | undefined>(undefined);
  const batch = picked ?? latestWithOrders ?? fallback;

  const chain = useBatchChain(m.market, batch);
  const detail = useBatchDetail(m.market, batch);
  const res = chain.result;
  // The API's rows carry each order's fill; the contract's rows are the same orders without it.
  const api = detail.data?.orders ?? [];
  const source: { account: string; sellAsset: boolean; amountIn: bigint; limitPrice: bigint; mode: number; status?: string }[] = api.length ? api : chain.orders;
  // A batch that cleared with every order unsettled (for example while the asset was paused) moved nothing.
  const nothingMoved = Boolean(res?.cleared && res.assetFilled === 0n && res.assetViaPool === 0n);
  const count = api.length || chain.count;
  const buys = source.filter((o) => !o.sellAsset).sort((a, b) => (a.limitPrice > b.limitPrice ? -1 : 1));
  const sells = source.filter((o) => o.sellAsset).sort((a, b) => (a.limitPrice < b.limitPrice ? -1 : 1));
  const d = m.decimals;
  const expired = detail.data?.status === "expired";

  return (
    <>
      <section className="rc-panel mk-book" aria-label="Revealed orders">
        <div className="rc-panel-head">
          <h2>{batch === undefined ? "Revealed orders" : `Batch ${batch.toLocaleString("en-US")}, revealed`}</h2>
          <p>An open batch keeps every order sealed. After its reveal window, the full book goes on record here beside its clearing price.</p>
        </div>
        {batch === undefined ? (
          <p className="rc-muted">The opening batch goes on record here after its reveal window.</p>
        ) : (
          <>
            <dl className="rc-rows mk-result">
              <Row label="Clearing price" hint={res?.cleared ? "Market price as the reveal window ended" : undefined}>
                {res?.cleared ? <Fig v={usd(pricePerToken(res.price, d))} unit={`USDG per ${m.symbol}`} /> : <span className="rc-muted-inline">{expired ? "No price on record" : chain.loaded ? (count > 0 ? "Clearing" : "No orders") : "…"}</span>}
              </Row>
              {res?.cleared && nothingMoved ? (
                <Row label="Result">
                  <span className="rc-muted-inline">No trade this batch, funds stayed put</span>
                </Row>
              ) : null}
              {res?.cleared && !nothingMoved ? (
                <>
                  {res.assetFilled > 0n || res.assetViaPool === 0n ? (
                    <Row label="Matched order to order">
                      <Fig v={amount(res.assetFilled, { decimals: d })} unit={`${m.symbol}, ${usdg(res.usdgFilled)} USDG`} />
                    </Row>
                  ) : null}
                  {res.assetViaPool > 0n ? (
                    <Row label="Traded in the Uniswap pool" hint="Eclipse orders left unmatched">
                      <Fig v={amount(res.assetViaPool, { decimals: d })} unit={`${m.symbol}, ${usdg(res.usdgViaPool)} USDG`} />
                    </Row>
                  ) : null}
                  <Row label="Treasury fees">
                    <Fig v={usdg(res.usdgFees)} unit="USDG" />
                  </Row>
                  {res.orryFeesBurned > 0n ? (
                    <Row label="ORRY fees burned">
                      <Fig v={amount(res.orryFeesBurned, { frac: 2 })} unit="ORRY" />
                    </Row>
                  ) : null}
                </>
              ) : null}
            </dl>
            {count === 0 ? (
              chain.loaded || detail.isFetched ? <p className="rc-muted">This batch ended with no revealed orders.</p> : null
            ) : (
              <div className="mk-sides">
                {([["Buy orders", buys, false], ["Sell orders", sells, true]] as const).map(([title, rows, sell]) => (
                  <div key={title}>
                    <h3>{title}</h3>
                    {rows.length === 0 ? (
                      <p className="rc-muted">Nothing on this side.</p>
                    ) : (
                      <table className="rc-table mk-side-table">
                        <thead>
                          <tr>
                            <th scope="col">Wallet</th>
                            <th scope="col" className="num">{sell ? `Size, ${m.symbol}` : "Size, USDG"}</th>
                            <th scope="col" className="num">Limit</th>
                            <th scope="col">Venue</th>
                            <th scope="col">Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((o, i) => {
                            const st = o.status;
                            return (
                              <tr key={`${o.account}-${i}`}>
                                <td data-label="Wallet" className="mono">{mask(o.account)}</td>
                                <td data-label="Size" className="num mono">{sell ? amount(o.amountIn, { decimals: d }) : usdg(o.amountIn)}</td>
                                <td data-label="Limit" className="num mono">{usd(pricePerToken(o.limitPrice, d))}</td>
                                <td data-label="Venue">{o.mode === 1 ? "Eclipse" : "Quiet Book"}</td>
                                <td data-label="Result">{st ? FILL[st] : res?.cleared ? "Settled" : "Awaiting settlement"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section className="rc-panel" aria-label="Recent batches">
        <div className="rc-panel-head">
          <h2>Recent batches</h2>
        </div>
        {batches.isLoading ? (
          <p className="rc-muted">…</p>
        ) : past.length === 0 ? (
          <p className="rc-muted">{batches.isError ? "Batch readings come into view in a moment." : "Each batch goes on record here as it clears."}</p>
        ) : (
          <table className="rc-table mk-batches">
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col">Result</th>
                <th scope="col" className="num">Price</th>
                <th scope="col" className="num">Filled</th>
                <th scope="col" className="num">Volume</th>
                <th scope="col" className="num">Orders</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {past.map((b) => (
                <tr key={b.batch.toString()} className={b.batch === batch ? "is-picked" : undefined}>
                  <td data-label="Batch">
                    <button type="button" className="mk-link" onClick={() => setPicked(b.batch)} aria-pressed={b.batch === batch}>
                      {b.batch.toLocaleString("en-US")}
                    </button>
                    <small className="mk-sub">{ago(b.revealEndsAt, rt.now)}</small>
                  </td>
                  <td data-label="Result">{b.reveals === 0 && b.status !== "cleared" ? "Nothing revealed" : b.status === "cleared" && b.result && b.result.ordersFilled === 0 ? "Cleared, nothing filled" : STATUS[b.status]}</td>
                  <td data-label="Price" className="num mono">{b.result && b.result.price > 0n ? usd(pricePerToken(b.result.price, d)) : ""}</td>
                  <td data-label="Filled" className="num mono">{b.result ? `${amount(b.result.assetFilled, { decimals: d })} ${m.symbol}` : ""}</td>
                  <td data-label="Volume" className="num mono">{b.result ? `${usdg(b.result.usdgFilled)} USDG` : ""}</td>
                  <td data-label="Orders" className="num mono">{b.reveals.toLocaleString("en-US")}</td>
                  <td data-label="Transaction">{b.result?.tx ? <TxLink hash={b.result.tx} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
