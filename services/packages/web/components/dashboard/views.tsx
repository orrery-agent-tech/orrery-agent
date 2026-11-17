"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { erc20Abi, type Abi, type Address } from "viem";
import { useConnection, useReadContract, useSimulateContract } from "wagmi";
import { iClaimAllAbi } from "@orrery/shared";
import { ADDRESSES, CHAIN_ID, deployed } from "@/lib/config";
import { STATUS, duration, isZero, short, usdg } from "@/lib/format";
import { useAgentView, useSignerView } from "@/lib/lens";
import { recall } from "@/lib/operator-setup";
import { useOrderHistory } from "@/lib/markets/api";
import { useMerchant } from "@/lib/merchants";
import { useAccountView } from "@/lib/orry/api";
import { useAccountChain, useNow, useTx } from "@/lib/orry/chain";
import { ORRY, contractsReady } from "@/lib/orry/config";
import { assetFrac, hasFees, hasShares, useAssetMeta, useEarnPositions } from "@/lib/orry/earn";
import { ago, amount, eth, orry, utc } from "@/lib/orry/format";
import { useReleases } from "@/lib/orry/releases";
import { ORDER_STATUS } from "../markets/MyOrders";
import { Integration, PaymentAddress, Profile } from "../merchants/MerchantsView";
import { OperatorWorkspace } from "../operator/OperatorWorkspace";
import { NoticeLine, TxLink } from "../orry/parts";
import { CreditsSummary } from "./credits";
import { AddressPill, Avatar, Empty, Loading, Panel, Rows, SoonBody, Stat } from "./ui";

const D = "/dashboard";
const fmtUsdg = (v?: bigint) => (v === undefined ? undefined : amount(v, { decimals: 6, frac: 2 }));

/** The connected wallet; the shell renders a section only while one is connected. */
function useMe(): Address {
  return useConnection().address as Address;
}

/** The agent this wallet last set up or opened in Agents (kept in this browser), read from the chain. */
function useMyAgent(address: Address) {
  const [mine, setMine] = useState<{ account?: string; agentId?: bigint }>({});
  useEffect(() => {
    const last = recall(CHAIN_ID, address);
    setMine({ account: last.account, agentId: last.agentId && /^\d+$/.test(last.agentId) ? BigInt(last.agentId) : undefined });
  }, [address]);
  const view = useAgentView(deployed ? mine.agentId : undefined, mine.account).data;
  return { ...mine, view };
}

function useUsdgBalance(address: Address) {
  return useReadContract({ address: ADDRESSES.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address], query: { enabled: Boolean(ADDRESSES.usdg), refetchInterval: 12_000 } }).data;
}

// ------------------------------------------------------------------ overview

export function OverviewView() {
  const address = useMe();
  const me = useAccountChain(address);
  const usdgBal = useUsdgBalance(address);
  const signer = useSignerView(deployed ? address : undefined).data;
  const releases = useReleases();
  const earnOn = contractsReady("earn");
  const stakeOn = contractsReady("stake");
  const { positions, loaded: earnLoaded } = useEarnPositions(earnOn ? address : undefined);
  const orders = useOrderHistory(ORRY.marketFactory ? address : undefined, 5);
  const merchant = useMerchant(ORRY.splitterFactory && releases.isLive("facilitator") ? address : undefined);
  const held = positions.filter((p) => hasShares(p) || hasFees(p));
  const mine = useMyAgent(address);
  // An operator's wallet owns the agent's account; the wallet is a signer itself only when it pays as an agent.
  const agent = mine.view && mine.agentId !== undefined ? { id: mine.agentId, view: mine.view } : signer && !isZero(signer.account) ? { id: signer.agentId, view: signer } : undefined;
  const session = agent ? (STATUS[agent.view.status] ?? "Unknown") : signer ? "No session" : undefined;

  return (
    <div className="cp-stack">
      <header className="cp-identity">
        <Avatar address={address} />
        <div>
          <span className="cp-eyebrow">Your account</span>
          <h2 className="mono">{`${address.slice(0, 6)}…${address.slice(-4)}`}</h2>
        </div>
        <AddressPill address={address} />
      </header>

      <div className="cp-stats">
        <Stat label="ETH" value={me.ethBalance === undefined ? undefined : eth(me.ethBalance)} />
        {ADDRESSES.usdg ? <Stat label="USDG" value={fmtUsdg(usdgBal)} /> : null}
        {ORRY.token ? <Stat label="ORRY" value={me.orryBalance === undefined ? undefined : orry(me.orryBalance)} /> : null}
        <Stat label="Agent session" value={deployed ? session : "Soon"} />
      </div>

      <div className="cp-grid">
        <CreditsSummary />

        <Panel title="Agent caps" action={deployed ? { href: `${D}/agents`, label: agent ? "Manage" : "Set up" } : undefined} soon={!deployed}>
          {!deployed ? (
            <SoonBody text="Once the Orrery contracts are deployed on this network, this wallet's agent caps show here." />
          ) : !signer ? (
            <Loading />
          ) : !agent ? (
            <Empty text="This wallet has not set up an agent yet." action={{ href: `${D}/agents`, label: "Set caps" }} />
          ) : (
            <Rows
              rows={[
                ["Agent", `#${agent.id.toString()}`],
                ["Session", session],
                ["Account", <span key="a" className="mono">{short(mine.view ? mine.account : agent.view.account)}</span>],
                ["Caps", `${agent.view.caps.length} ${agent.view.caps.length === 1 ? "token" : "tokens"}`],
              ]}
            />
          )}
        </Panel>

        <Panel title="Positions" action={stakeOn || earnOn ? { href: `${D}/positions`, label: "View" } : undefined} soon={!(releases.isLive("stake") || releases.isLive("earn"))}>
          {!(stakeOn || earnOn) ? (
            <SoonBody text="Your stake, Earn shares and rewards show here once ORRY launches." />
          ) : me.rewardsEth === undefined && !earnLoaded ? (
            <Loading />
          ) : (
            <Rows
              rows={[
                ...(stakeOn ? ([["Active stake", `${orry(me.stakeActive ?? 0n)} ORRY`], ["Claimable rewards", `${eth(me.rewardsEth ?? 0n)} ETH · ${orry(me.rewardsOrry ?? 0n)} ORRY`]] as [string, string][]) : []),
                ...(earnOn ? ([["Earn pools", held.length ? `${held.length} holding a deposit or fees` : "No deposit"]] as [string, string][]) : []),
              ]}
            />
          )}
        </Panel>

        <Panel title="Merchant" action={ORRY.splitterFactory && releases.isLive("facilitator") ? { href: `${D}/merchant`, label: "View" } : undefined} soon={!releases.isLive("facilitator")}>
          {!releases.isLive("facilitator") ? (
            <SoonBody text="Once merchant payments go live, the address agents pay you at shows here." />
          ) : !merchant.data ? (
            <Loading />
          ) : (
            <Rows
              rows={[
                ["Payment address", <span key="p" className="mono">{short(merchant.data.splitter)}</span>],
                ["Status", merchant.data.created ? "Taking payments" : "Not created"],
                ["Payments, 30 days", merchant.data.settled30d.reduce((n, s) => n + s.payments, 0).toString()],
              ]}
            />
          )}
        </Panel>

        <Panel title="Recent orders" action={ORRY.marketFactory ? { href: `${D}/orders`, label: "View all" } : undefined} soon={!(releases.isLive("stocks") || releases.isLive("swap") || releases.isLive("darkpool"))}>
          {!ORRY.marketFactory ? (
            <SoonBody text="Once the markets go live, your sealed orders show here." />
          ) : orders.isLoading ? (
            <Loading />
          ) : orders.isError ? (
            <Empty text="Your orders show up in a moment." />
          ) : !(orders.data ?? []).length ? (
            <Empty text="This wallet has placed no orders yet." />
          ) : (
            <OrdersTable rows={(orders.data ?? []).slice(0, 5)} compact />
          )}
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ agents

export function AgentsView() {
  const address = useMe();
  const now = useNow();
  const { data: view, isLoading } = useSignerView(deployed ? address : undefined);
  const stakeOn = contractsReady("stake");
  const account = useAccountView(stakeOn ? address : undefined);
  const stakes = (account.data?.agents ?? []).filter((a) => a.active > 0n || a.leaving > 0n);
  const isUsdg = (t: Address) => ADDRESSES.usdg && t.toLowerCase() === ADDRESSES.usdg.toLowerCase();

  if (!deployed) {
    return (
      <Panel title="Signer record" soon>
        <SoonBody text="Once the Orrery contracts are deployed on this network, this wallet's agent caps show here." />
      </Panel>
    );
  }
  // The signer record shows only for a wallet that pays as an agent itself; an operator's wallet works in the workspace above it.
  const isSigner = Boolean(view && !isZero(view.account));
  return (
    <div className="cp-stack">
      <OperatorWorkspace />
      {isSigner && view ? (
      <Panel title="This wallet signs for an agent">
        {isLoading ? (
          <Loading lines={4} />
        ) : (
          <>
            <Rows
              rows={[
                ["Agent", `#${view.agentId.toString()}`],
                ["Session", STATUS[view.status] ?? "Unknown"],
                ["Account", <span key="a" className="mono">{view.account}</span>],
                ["Limits", view.pendingReadyAt > 0n ? `Higher caps apply in ${duration(Number(view.pendingReadyAt) - now)}` : `Any raise waits ${duration(view.increaseDelay)}`],
              ]}
            />
            <div className="cp-table-wrap">
              <table className="cp-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Per payment</th>
                    <th>Per day</th>
                    <th>Float ceiling</th>
                    <th>Spent today</th>
                  </tr>
                </thead>
                <tbody>
                  {view.caps.map((c) => {
                    const unit = isUsdg(c.token) ? "USDG" : isZero(c.token) ? "ETH" : short(c.token);
                    const f = (v: bigint) => (isUsdg(c.token) ? usdg(v) : v.toString());
                    const pct = c.perDay > 0n ? Math.min(100, Number((c.spentToday * 10000n) / c.perDay) / 100) : 0;
                    return (
                      <tr key={c.token}>
                        <td>{unit}</td>
                        <td className="num">{f(c.perTx)}</td>
                        <td className="num">{f(c.perDay)}</td>
                        <td className="num">{f(c.floatMax)}</td>
                        <td className="num">
                          {f(c.spentToday)}
                          <span className="cp-bar">
                            <i style={{ width: `${pct}%` }} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <h3 className="cp-sub">Allowed targets</h3>
            {view.targets.length === 0 ? (
              <p className="cp-note">None. The signer may only refill its float.</p>
            ) : (
              <ul className="cp-list">
                {view.targets.map((t) => (
                  <li key={`${t.target}${t.selector}`}>
                    <span className="mono">{short(t.target)}</span>
                    <span className="mono cp-muted">{t.selector}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="cp-note">
              <Link href={`/signer/${address}`}>Open this signer's public record</Link>
            </p>
          </>
        )}
      </Panel>
      ) : null}

      {/* While staking is held, the workspace above already carries its "Coming soon" note; one is enough. */}
      {stakeOn ? (
      <Panel title="Your agent stakes" soon={!stakeOn} action={stakeOn ? { href: "/stake", label: "Manage stake" } : undefined}>
        {!stakeOn ? (
          <SoonBody text="Once staking goes live, stake you place behind agents shows here." />
        ) : account.isLoading ? (
          <Loading />
        ) : stakes.length === 0 ? (
          <Empty text="This wallet backs no agent with stake." />
        ) : (
          <div className="cp-table-wrap">
            <table className="cp-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Active</th>
                  <th>Leaving</th>
                  <th>Leaves at</th>
                </tr>
              </thead>
              <tbody>
                {stakes.map((a) => (
                  <tr key={a.agentId.toString()}>
                    <td>#{a.agentId.toString()}</td>
                    <td className="num">{orry(a.active)} ORRY</td>
                    <td className="num">{orry(a.leaving)} ORRY</td>
                    <td className="num">{a.leavingAt ? utc(a.leavingAt) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ merchant

export function MerchantView() {
  const address = useMe();
  const releases = useReleases();
  const on = Boolean(ORRY.splitterFactory) && releases.isLive("facilitator");
  const me = useMerchant(on ? address : undefined);
  if (!on) {
    return (
      <Panel title="Payment address" soon>
        <SoonBody text="Once merchant payments go live, your payment address, its balances and your public profile show here." />
      </Panel>
    );
  }
  if (!me.data) return <Panel title="Payment address"><Loading lines={4} /></Panel>;
  return (
    <div className="cp-stack cp-merchant">
      <Panel title="Payment address" action={{ href: "/docs/merchants", label: "Guide" }}>
        <PaymentAddress view={me.data} onChange={() => void me.refetch()} />
      </Panel>
      {me.data.created ? (
        <Panel title="Public profile">
          <Profile view={me.data} onSaved={() => void me.refetch()} />
        </Panel>
      ) : null}
      <Panel title="Accept agent payments in your API">
        <Integration payTo={me.data.splitter} />
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ positions

export function PositionsView() {
  const address = useMe();
  const now = useNow();
  const tx = useTx();
  const stakeOn = contractsReady("stake");
  const earnOn = contractsReady("earn");
  const me = useAccountChain(address);
  const earn = useEarnPositions(earnOn ? address : undefined);
  const metaOf = useAssetMeta();
  const sim = useSimulateContract({ address: ORRY.claimAll, abi: iClaimAllAbi, functionName: "claimAll", account: address, query: { enabled: Boolean(ORRY.claimAll), refetchInterval: 12_000 } });
  const paid = (sim.data?.result as readonly { asset: Address; amount: bigint }[] | undefined)?.map((p) => ({ ...p, meta: metaOf(p.asset) })).filter((p) => p.amount > 0n);
  const held = earn.positions.filter((p) => hasShares(p) || hasFees(p));

  if (!stakeOn && !earnOn) {
    return (
      <Panel title="Positions" soon>
        <SoonBody text="Your stake, Earn shares and rewards show here once ORRY launches." />
      </Panel>
    );
  }
  async function claimAll() {
    await tx.run("Claim all", async ({ send }) => {
      await send({ address: ORRY.claimAll as Address, abi: iClaimAllAbi as Abi, functionName: "claimAll" });
      void sim.refetch();
      earn.refetch();
      return "All fees and rewards are now in your wallet.";
    });
  }
  return (
    <div className="cp-stack">
      <Panel title="Claimable now">
        {paid === undefined ? (
          <Loading lines={2} />
        ) : paid.length === 0 ? (
          <Empty text="Nothing to claim yet. Fees and rewards accrue as time passes." />
        ) : (
          <div className="cp-claim">
            <ul className="cp-assets">
              {paid.map((p) => (
                <li key={p.asset}>
                  <strong className="num">{p.meta ? amount(p.amount, { decimals: p.meta.decimals, frac: assetFrac(p.meta.symbol) }) : "…"}</strong>
                  <span>{p.meta?.symbol}</span>
                </li>
              ))}
            </ul>
            <button className="cp-btn cp-btn-primary" type="button" disabled={Boolean(tx.busy)} onClick={() => void claimAll()}>
              Claim all
            </button>
          </div>
        )}
        <NoticeLine notice={tx.notice} />
      </Panel>

      <div className="cp-grid">
        {stakeOn ? (
          <Panel title="Stake" action={{ href: "/stake", label: "Manage stake" }}>
            <Rows
              rows={[
                ["Active", me.stakeActive === undefined ? "…" : `${orry(me.stakeActive)} ORRY`],
                ["Leaving", `${orry(me.stakeLeaving ?? 0n)} ORRY`],
                ...((me.stakeLeaving ?? 0n) > 0n ? ([["Withdraw from", me.stakeReadyAt <= now ? "Ready now" : utc(me.stakeReadyAt)]] as [string, string][]) : []),
                ["Rewards", me.rewardsEth === undefined ? "…" : `${eth(me.rewardsEth)} ETH · ${orry(me.rewardsOrry ?? 0n)} ORRY`],
              ]}
            />
          </Panel>
        ) : null}
        {earnOn ? (
          <Panel title="Earn" action={{ href: "/earn", label: "Manage Earn" }}>
            {!earn.loaded ? (
              <Loading />
            ) : held.length === 0 ? (
              <Empty text="This wallet holds no Earn deposit." action={{ href: "/earn", label: "Open Earn" }} />
            ) : (
              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th>Unlocks</th>
                      <th>Claimable fees</th>
                    </tr>
                  </thead>
                  <tbody>
                    {held.map((p) => (
                      <tr key={p.vault}>
                        <td>ORRY/{p.quote.symbol}</td>
                        <td className="num">{p.unlockAt > now ? utc(p.unlockAt) : "Unlocked"}</td>
                        <td className="num">
                          {amount(p.feesQuote ?? 0n, { decimals: p.quote.decimals, frac: assetFrac(p.quote.symbol) })} {p.quote.symbol} · {orry(p.feesOrry ?? 0n)} ORRY
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ orders

type OrderRow = ReturnType<typeof useOrderHistory>["data"] extends (infer T)[] | undefined ? T : never;

function OrdersTable({ rows, compact = false }: { rows: OrderRow[]; compact?: boolean }) {
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="cp-table-wrap">
      <table className="cp-table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Batch</th>
            {compact ? null : <th>Sealed</th>}
            <th>Result</th>
            {compact ? null : <th>Transaction</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={`${o.market}-${o.batch}`}>
              <td>{o.symbol}</td>
              <td className="num">{o.batch.toString()}</td>
              {compact ? null : <td className="num">{o.committedAt ? ago(o.committedAt, now) : ""}</td>}
              <td>{ORDER_STATUS[o.status]}</td>
              {compact ? null : <td>{o.revealTx ? <TxLink hash={o.revealTx} /> : o.commitTx ? <TxLink hash={o.commitTx} /> : null}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OrdersView() {
  const address = useMe();
  const releases = useReleases();
  const on = Boolean(ORRY.marketFactory);
  const orders = useOrderHistory(on ? address : undefined, 50);
  const open = releases.isLive("stocks") || releases.isLive("swap") || releases.isLive("darkpool");
  if (!on) {
    return (
      <Panel title="Orders" soon>
        <SoonBody text="Once the markets go live, your sealed orders show here." />
      </Panel>
    );
  }
  return (
    <Panel title="Orders" soon={!open} action={open ? { href: "/stocks", label: "Open Markets" } : undefined}>
      {orders.isLoading ? (
        <Loading lines={5} />
      ) : orders.isError ? (
        <Empty text="Your orders show up in a moment." />
      ) : !(orders.data ?? []).length ? (
        <Empty text="This wallet has placed no orders yet." action={open ? { href: "/stocks", label: "Open Markets" } : undefined} />
      ) : (
        <OrdersTable rows={orders.data ?? []} />
      )}
    </Panel>
  );
}
