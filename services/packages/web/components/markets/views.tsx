"use client";

import Link from "next/link";
import { ADDRESSES, activeChain } from "@/lib/config";
import { useWallet } from "@/lib/orry/chain";
import { ago, amount } from "@/lib/orry/format";
import { useMarkets, type Market } from "@/lib/markets/api";
import { useHoldings } from "@/lib/markets/chain";
import { feedToPrice, pricePerToken, usd, usdg, usdgFor } from "@/lib/markets/math";
import { WalletButton } from "../WalletButton";
import { Fig, OrryHead, Row } from "../orry/parts";
import { BatchBook } from "./BatchBook";
import { MyOrders } from "./MyOrders";
import { OrderDesk } from "./OrderDesk";
import { StockMark } from "./parts";
import { useRuntime } from "./runtime";
import { MarketClock, MarketFacts, useMarketPick } from "./side";

/** Listed markets (each with its official logo) from the API, or the neutral state while they load. */
function useMarketList() {
  const q = useMarkets(activeChain.id);
  const markets = q.data?.markets ?? [];
  const waiting = q.isLoading || (q.isError && !q.data);
  return { markets, waiting, empty: !waiting && markets.length === 0, skew: q.data?.skew ?? 0 };
}

function Waiting({ empty }: { empty: boolean }) {
  return <p className="rc-muted mk-wait">{empty ? "Each stock market is plotted here the day it opens." : "Stock markets come into view in a moment."}</p>;
}

const priceOf = (m: Market) => (m.price ? pricePerToken(feedToPrice(m.price.answer, m.price.decimals, m.decimals), m.decimals) : undefined);

export function SwapView() {
  const { markets, waiting, empty, skew } = useMarketList();
  const { m, pick } = useMarketPick(markets);
  return (
    <>
      <OrryHead
        title="Trade stock tokens without showing your hand."
        lead={<p>Until the batch closes, the chain holds only a hash of your order. This page reveals it for you, and the trade settles wallet to wallet at the batch&apos;s market price.</p>}
        reading={m ? <div className="rc-card"><p className="rc-card-title">{m.name}<span>{m.symbol}</span></p><MarketClock m={m} skew={skew} /></div> : undefined}
      />
      {!m ? (
        <Waiting empty={empty || !waiting} />
      ) : (
        <>
          <div className="rc-grid">
            <OrderDesk mode={1} markets={markets} symbol={m.symbol} onSymbol={pick} skew={skew} />
            <aside className="rc-side">
              <h2>The course of one swap</h2>
              <ol className="mk-steps">
                <li>
                  <strong>Seal</strong>
                  <span>The chain records a hash. Your amount and side are known only to you.</span>
                </li>
                <li>
                  <strong>Reveal</strong>
                  <span>As soon as sealing ends, this page asks your wallet to reveal the order.</span>
                </li>
                <li>
                  <strong>Clear</strong>
                  <span>Orders that cross settle at a single market price. Where the market has a Uniswap pool, the unmatched part trades there, held close to that price. Whatever remains comes back to your wallet in the same transaction.</span>
                </li>
              </ol>
              <MarketFacts m={m} />
            </aside>
          </div>
          <MyOrders markets={markets} mode={1} />
        </>
      )}
    </>
  );
}

export function DarkPoolView() {
  const { markets, waiting, empty, skew } = useMarketList();
  const { m, pick } = useMarketPick(markets);
  return (
    <>
      <OrryHead
        title="Size that leaves the price where it was."
        lead={<p>Here a limit order crosses only with other orders, at the market price on record when the batch clears, so a large ticket leaves no mark on the price. Each order stays sealed through its batch and goes on record in the book below afterwards.</p>}
        reading={m ? <div className="rc-card"><p className="rc-card-title">{m.name}<span>{m.symbol}</span></p><MarketClock m={m} skew={skew} /></div> : undefined}
      />
      {!m ? (
        <Waiting empty={empty || !waiting} />
      ) : (
        <>
          <div className="rc-grid">
            <OrderDesk mode={0} markets={markets} symbol={m.symbol} onSymbol={pick} skew={skew} />
            <aside className="rc-side">
              <h2>{m.name}</h2>
              <MarketFacts m={m} />
            </aside>
          </div>
          <BatchBook m={m} />
          <MyOrders markets={markets} market={m.market} mode={0} />
        </>
      )}
    </>
  );
}

export function StocksView() {
  const { markets, waiting, empty } = useMarketList();
  const { address } = useWallet();
  const rt = useRuntime();
  // The wallet's USDG is read with its stock tokens, so the card can show the two apart.
  const held = useHoldings([...markets.map((m) => m.asset), ...(ADDRESSES.usdg ? [ADDRESSES.usdg] : [])], address);
  const value = (m: Market) => {
    const h = held?.get(m.asset.toLowerCase());
    return h !== undefined && m.price ? usdgFor(h, feedToPrice(m.price.answer, m.price.decimals, m.decimals)) : undefined;
  };
  const stocks = held && markets.length ? markets.reduce((s, m) => s + (value(m) ?? 0n), 0n) : undefined;
  const cash = ADDRESSES.usdg ? held?.get(ADDRESSES.usdg.toLowerCase()) : undefined;
  const total = stocks !== undefined ? stocks + (cash ?? 0n) : undefined;
  const ownedList = held ? markets.filter((m) => (held.get(m.asset.toLowerCase()) ?? 0n) > 0n) : [];
  const SHOWN = 4;

  return (
    <>
      <OrryHead
        title="Every listed stock token, on one chart."
        lead={<p>Robinhood Chain stock tokens, each traded for USDG in sealed batches at its real-world market price. The prices below are the same ones every batch clears at.</p>}
        reading={
          <div className="rc-card">
            <p className="rc-card-title">Held in this wallet</p>
            {address ? (
              <>
                <p className="rc-big">
                  <Fig v={total !== undefined ? usdg(total) : undefined} unit="USDG" />
                </p>
                <p className="rc-muted">{held ? "Stock tokens at today's market price, plus the USDG in this wallet." : "…"}</p>
                {held ? (
                  <dl className="rc-rows rc-rows-tight">
                    {ownedList.slice(0, SHOWN).map((m) => (
                      <Row key={m.market} label={`${amount(held.get(m.asset.toLowerCase()), { decimals: m.decimals, frac: 4 })} ${m.symbol}`}>
                        <Fig v={usdg(value(m))} unit="USDG" />
                      </Row>
                    ))}
                    {ownedList.length > SHOWN ? (
                      <Row label={`${ownedList.length - SHOWN} more stock ${ownedList.length - SHOWN === 1 ? "token" : "tokens"}`}>
                        <Fig v={usdg(ownedList.slice(SHOWN).reduce((s, m) => s + (value(m) ?? 0n), 0n))} unit="USDG" />
                      </Row>
                    ) : null}
                    {ownedList.length === 0 ? <Row label="Stock tokens">None yet</Row> : null}
                    <Row label="USDG">
                      <Fig v={cash !== undefined ? amount(cash, { decimals: 6, frac: 3 }) : undefined} unit="USDG" />
                    </Row>
                  </dl>
                ) : null}
              </>
            ) : (
              <div className="rc-connect">
                <p>Connect a wallet to read its holdings.</p>
                <WalletButton />
              </div>
            )}
          </div>
        }
      />
      {markets.length === 0 ? (
        <Waiting empty={empty || !waiting} />
      ) : (
        <section className="rc-panel mk-stocks" aria-label="Stock tokens">
          <table className="rc-table">
            <thead>
              <tr>
                <th scope="col">Stock</th>
                <th scope="col" className="num">Price</th>
                <th scope="col">Updated</th>
                <th scope="col" className="num">You hold</th>
                <th scope="col" className="num">Value</th>
                <th scope="col">
                  <span className="sr-only">Trade</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const p = priceOf(m);
                const h = held?.get(m.asset.toLowerCase());
                const v = value(m);
                return (
                  <tr key={m.market}>
                    <td data-label="Stock">
                      <Link href={`/stocks/${m.symbol}`} className="mk-stock">
                        {m.logo ? <StockMark logo={m.logo} /> : null}
                        <span>
                          <strong>{m.name}</strong>
                          <small>{m.symbol}</small>
                        </span>
                      </Link>
                    </td>
                    <td data-label="Price" className="num mono">{p !== undefined ? `${usd(p)} USDG` : "Updating"}{m.fresh ? null : <small className="mk-sub">Moves next US session</small>}</td>
                    <td data-label="Updated">{m.price?.updatedAt ? ago(m.price.updatedAt, rt.now) : ""}</td>
                    <td data-label="You hold" className="num mono">{address ? (h === undefined ? "…" : `${amount(h, { decimals: m.decimals })} ${m.symbol}`) : ""}</td>
                    <td data-label="Value" className="num mono">{address && v !== undefined ? `${usdg(v)} USDG` : ""}</td>
                    <td data-label="">
                      <Link className="secondary mk-trade" href={`/stocks/${m.symbol}`}>
                        Trade
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

export function AssetView({ symbol }: { symbol: string }) {
  const { markets, waiting, empty, skew } = useMarketList();
  const { address } = useWallet();
  const rt = useRuntime();
  const m = markets.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  const held = useHoldings(m ? [m.asset] : [], address);
  const h = m ? held?.get(m.asset.toLowerCase()) : undefined;
  const p = m ? priceOf(m) : undefined;

  if (!m) {
    return (
      <>
        <OrryHead title={symbol.toUpperCase()} />
        {waiting ? (
          <Waiting empty={false} />
        ) : (
          <p className="rc-muted mk-wait">
            {empty ? "Each stock market is plotted here the day it opens." : `There is no ${symbol.toUpperCase()} market here.`} <Link href="/stocks">All stocks</Link>
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <OrryHead
        kicker={m.symbol}
        title={m.name}
        lead={<p>Trade {m.symbol} for USDG in the coming batch. Your order is sealed for the whole batch, then settles at the live market price.</p>}
        reading={
          <div className="rc-card">
            <p className="rc-card-title">
              <span className="mk-card-stock">
                {m.logo ? <StockMark logo={m.logo} size={28} /> : null}
                {m.symbol}
              </span>
              <span>{m.price?.updatedAt ? `Market price, ${ago(m.price.updatedAt, rt.now)}` : ""}</span>
            </p>
            <p className="rc-big">
              <Fig v={p !== undefined ? usd(p) : "Updating"} unit={p !== undefined ? "USDG" : undefined} />
            </p>
            {address ? (
              <dl className="rc-rows rc-rows-tight">
                <Row label="You hold">
                  <Fig v={h === undefined ? undefined : amount(h, { decimals: m.decimals })} unit={m.symbol} />
                </Row>
              </dl>
            ) : null}
          </div>
        }
      />
      <div className="rc-grid">
        <OrderDesk mode={1} markets={markets} symbol={m.symbol} fixed skew={skew} />
        <aside className="rc-side">
          <MarketClock m={m} skew={skew} />
          <MarketFacts m={m} />
          <p className="mk-more">
            Trading in size? <Link href={`/quiet-book?stock=${m.symbol}`}>Name your limit in the Quiet Book</Link>
          </p>
        </aside>
      </div>
      <BatchBook m={m} />
      <MyOrders markets={markets} market={m.market} />
    </>
  );
}
