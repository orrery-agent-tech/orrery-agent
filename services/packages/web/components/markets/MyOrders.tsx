"use client";

import type { Address, Hex } from "viem";
import { useWallet } from "@/lib/orry/chain";
import { amount, orry } from "@/lib/orry/format";
import { useOrderHistory, type HistoryStatus, type Market } from "@/lib/markets/api";
import { pricePerToken, usd, usdg } from "@/lib/markets/math";
import type { SealedOrder } from "@/lib/markets/store";
import { TxLink } from "../orry/parts";
import { orderTitle } from "./parts";
import { useRuntime } from "./runtime";

export const ORDER_STATUS: Record<HistoryStatus, string> = {
  committed: "Sealed",
  revealed: "Revealed",
  filled: "Filled",
  partial: "Partly filled",
  unfilled: "Not filled, funds stayed in wallet",
  dropped: "Not settled",
  expired: "No price on record",
  missed: "Not revealed",
};

interface Line {
  key: string;
  symbol: string;
  decimals: number;
  batch: bigint;
  sellAsset?: boolean;
  amountIn?: bigint;
  limitPrice?: bigint;
  status: HistoryStatus;
  output: bigint;
  usdgFee: bigint;
  orryFee: bigint;
  tx?: Hex;
  mode?: number;
}

const fromLocal = (o: SealedOrder): HistoryStatus => {
  if (o.state === "settled") return (o.outcome?.status ?? "unfilled") as HistoryStatus;
  if (o.state === "missed") return "missed";
  if (o.state === "revealed") return "revealed";
  return "committed";
};

/**
 * This wallet's orders: the API's history, plus orders sealed from this browser that the API has not listed yet.
 * `market` limits the list to one stock; `mode` to one venue.
 */
export function MyOrders({ markets, market, mode }: { markets: Market[]; market?: Address; mode?: 0 | 1 }) {
  const { address } = useWallet();
  const rt = useRuntime();
  const history = useOrderHistory(address);
  const dec = (a: string) => markets.find((m) => m.market.toLowerCase() === a.toLowerCase())?.decimals ?? 18;
  const same = (a: string) => !market || a.toLowerCase() === market.toLowerCase();

  const lines = new Map<string, Line>();
  for (const h of history.data ?? []) {
    if (!same(h.market) || (mode !== undefined && h.order && h.order.mode !== mode)) continue;
    const key = `${h.market.toLowerCase()}:${h.batch}`;
    lines.set(key, {
      key,
      symbol: h.symbol,
      decimals: dec(h.market),
      batch: h.batch,
      sellAsset: h.order?.sellAsset,
      amountIn: h.order?.amountIn,
      limitPrice: h.order?.limitPrice,
      status: h.status,
      output: h.fill?.output ?? 0n,
      usdgFee: h.fill?.usdgFee ?? 0n,
      orryFee: h.fill?.orryFee ?? 0n,
      tx: h.fill?.tx ?? h.revealTx ?? h.commitTx,
      mode: h.order?.mode,
    });
  }
  for (const o of rt.orders) {
    const key = `${o.market.toLowerCase()}:${o.batch}`;
    if (!same(o.market)) continue;
    // This browser knows the venue of an order the API cannot see yet (unrevealed): drop it from the other venue's list.
    if (mode !== undefined && o.order.mode !== mode) {
      lines.delete(key);
      continue;
    }
    const known = lines.get(key);
    // The browser knows the terms of its own sealed orders before the API can show them.
    if (known && known.amountIn !== undefined && known.status !== "committed") continue;
    lines.set(key, {
      key,
      symbol: o.symbol,
      decimals: o.assetDecimals,
      batch: BigInt(o.batch),
      sellAsset: o.order.sellAsset,
      amountIn: BigInt(o.order.amountIn),
      limitPrice: BigInt(o.order.limitPrice),
      status: known && known.status !== "committed" ? known.status : fromLocal(o),
      output: BigInt(o.outcome?.output ?? known?.output ?? 0n),
      usdgFee: BigInt(o.outcome?.usdgFee ?? known?.usdgFee ?? 0n),
      orryFee: BigInt(o.outcome?.orryFee ?? known?.orryFee ?? 0n),
      tx: o.outcome?.clearTx ?? o.revealTx ?? o.commitTx,
      mode: o.order.mode,
    });
  }
  const rows = [...lines.values()].sort((a, b) => (a.batch > b.batch ? -1 : 1)).slice(0, 30);

  return (
    <section className="rc-panel" aria-label="Your orders">
      <div className="rc-panel-head">
        <h2>Your orders</h2>
      </div>
      {!address ? (
        <p className="rc-muted">Connect a wallet to read its order record.</p>
      ) : rows.length === 0 ? (
        <p className="rc-muted">{history.isLoading ? "…" : "Each order you seal is logged here, and its outcome follows when the batch clears."}</p>
      ) : (
        <table className="rc-table mk-orders">
          <thead>
            <tr>
              <th scope="col">Batch</th>
              <th scope="col">Order</th>
              <th scope="col" className="num">Limit</th>
              <th scope="col">Result</th>
              <th scope="col" className="num">Received</th>
              <th scope="col" className="num">Fee</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const got = r.output > 0n ? (r.sellAsset ? `${usdg(r.output)} USDG` : `${amount(r.output, { decimals: r.decimals })} ${r.symbol}`) : "";
              const fee = r.orryFee > 0n ? `${orry(r.orryFee)} ORRY` : r.usdgFee > 0n ? `${usdg(r.usdgFee)} USDG` : "";
              return (
                <tr key={r.key}>
                  <td data-label="Batch" className="mono">
                    {r.batch.toLocaleString("en-US")}
                  </td>
                  <td data-label="Order">
                    {r.sellAsset === undefined || r.amountIn === undefined ? r.symbol : orderTitle({ sellAsset: r.sellAsset, amountIn: r.amountIn }, r.symbol, r.decimals)}
                    {r.mode !== undefined ? <small className="mk-sub">{r.mode === 1 ? "Eclipse" : "Quiet Book"}</small> : null}
                  </td>
                  <td data-label="Limit" className="num mono">{r.limitPrice !== undefined ? usd(pricePerToken(r.limitPrice, r.decimals)) : ""}</td>
                  <td data-label="Result">{ORDER_STATUS[r.status]}</td>
                  <td data-label="Received" className="num mono">{got}</td>
                  <td data-label="Fee" className="num mono">{fee}</td>
                  <td data-label="Transaction">{r.tx ? <TxLink hash={r.tx} /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
