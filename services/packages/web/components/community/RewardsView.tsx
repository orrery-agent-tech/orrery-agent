"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { encodeAbiParameters, keccak256, parseAbi, type Abi, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { REWARD_KINDS, orryAchievementsAbi, rewardPoolAbi, type CommunityAchievement, type CommunityRewardEvent } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { ComingSoon, NoticeLine, OrryHead, Row } from "@/components/orry/parts";
import { useMostActive, useRecipients, useRewards, type RewardsResponse } from "@/lib/community/api";
import { assetAmount, useAssetMeta, type AssetMeta } from "@/lib/community/assets";
import { useCommunity, type CommunityConfig } from "@/lib/community/config";
import { isZeroAddr, sameAddr, usd } from "@/lib/community/logic";
import { useCommunityTx } from "@/lib/community/tx";
import { big, time } from "@/lib/orry/api";
import { useNow, useWallet } from "@/lib/orry/chain";
import { COMING_SOON, ORRY } from "@/lib/orry/config";
import { mask, period, span, utc } from "@/lib/orry/format";

const poolAbi = rewardPoolAbi as Abi;
const achievementsAbi = orryAchievementsAbi as Abi;
/** The two verifiers' own views: VerifiedAgentVerifier has `attestor`, StakeUsdVerifier has `minStakeUsd`. */
const verifierAbi = parseAbi(["function attestor() view returns (address)", "function minStakeUsd() view returns (uint256)"]);

const kindName = (kind: number, name?: string) => name || REWARD_KINDS[kind] || "Reward";
/** USDG-only mode (ORRY not configured): the pool is funded in USDG, so no chat, name or tip wording, and no weekly ranking. */
const USDG_ONLY = !ORRY.token;

export function RewardsView() {
  const { config } = useCommunity();
  const rewards = useRewards(true);
  const data = rewards.data;
  const assets = [...(data?.pool ?? []).map((p) => p.asset), ...(data?.events ?? []).map((e) => e.asset), ...(data?.achievements ?? []).map((a) => a.asset)];
  const meta = useAssetMeta(assets, config?.addresses.orry ?? null);
  if (!config) return null;
  return (
    <>
      <OrryHead
        title="What the Reward Pool pays out."
        lead={
          USDG_ONLY ? (
            <p>Orrery funds the Reward Pool in USDG. Each achievement below pays the same reward to every wallet that completes it, in the order the wallets get there.</p>
          ) : (
            <p>The Reward Pool collects chat fees, name fees and a share of each tip. From it come bug bounties, prizes for each week&apos;s most active wallets and the achievements listed below.</p>
          )
        }
        reading={<PoolCard data={data} error={rewards.isError} meta={meta} />}
      />
      {USDG_ONLY && !data?.events?.length ? null : <Events cfg={config} events={data?.events} loading={rewards.isLoading} meta={meta} />}
      <Board cfg={config} data={data} loading={rewards.isLoading} meta={meta} />
      {USDG_ONLY ? null : <MostActive />}
    </>
  );
}

function PoolCard({ data, error, meta }: { data?: RewardsResponse; error: boolean; meta: (a: string) => AssetMeta | undefined }) {
  const pool = (data?.pool ?? []).filter((p) => big(p.free) + big(p.locked) > 0n);
  return (
    <div className="rc-card">
      <p className="rc-card-title">Reward Pool</p>
      {!data ? (
        <p className="rc-card-wait">{error ? "Pool balances load in a moment." : "…"}</p>
      ) : pool.length === 0 ? (
        <p className="rc-card-wait">{USDG_ONLY ? "The pool balance shows here once it is funded." : "Balances are charted here as fees flow in."}</p>
      ) : (
        <dl className="rc-rows">
          {pool.map((p) => {
            const m = meta(p.asset);
            const locked = big(p.locked);
            return (
              <Row key={p.asset} label={m?.symbol ?? mask(p.asset)} hint={locked > 0n && m ? `${assetAmount(locked, m)} reserved for rewards in progress` : undefined}>
                {assetAmount(big(p.free) + locked, m) || "…"}
              </Row>
            );
          })}
        </dl>
      )}
    </div>
  );
}

function Events({ cfg, events, loading, meta }: { cfg: CommunityConfig; events?: CommunityRewardEvent[]; loading: boolean; meta: (a: string) => AssetMeta | undefined }) {
  const list = events ?? [];
  return (
    <section className="rc-panel" aria-label="Events">
      <div className="rc-panel-head">
        <h2>Events</h2>
        <p>
          Bug bounties, quests and the weekly most active wallets. Each list of winners stays open to public review
          {cfg.checkWindowSeconds > 0 ? ` for ${period(cfg.checkWindowSeconds)}` : ""}, after which every winner collects their prize.
        </p>
      </div>
      {loading ? (
        <p className="rc-muted">…</p>
      ) : list.length === 0 ? (
        <p className="rc-muted">The next event is listed here once it starts.</p>
      ) : (
        <ul className="cm-events">
          {list.map((e) => (
            <EventRow key={e.id} cfg={cfg} event={e} meta={meta(e.asset)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EventRow({ cfg, event: e, meta }: { cfg: CommunityConfig; event: CommunityRewardEvent; meta?: AssetMeta }) {
  const { address, ready } = useWallet();
  const now = useNow(5000);
  const tx = useCommunityTx();
  const pool = cfg.addresses.pool as Address;
  const published = e.status === "published";
  const mine = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: pool, abi: rewardPoolAbi, functionName: "prizeOf", args: [BigInt(e.id), address ?? "0x0000000000000000000000000000000000000000"] },
      { address: pool, abi: rewardPoolAbi, functionName: "claimed", args: [BigInt(e.id), address ?? "0x0000000000000000000000000000000000000000"] },
    ],
    query: { enabled: Boolean(address && published) },
  });
  const prize = mine.data?.[0]?.status === "success" ? (mine.data[0].result as bigint) : 0n;
  const claimed = mine.data?.[1]?.status === "success" ? Boolean(mine.data[1].result) : false;
  const deadline = time(e.deadline);
  const payableAt = e.payableAt ? time(e.payableAt) : 0;

  const status =
    e.status === "open"
      ? deadline > now
        ? `Runs until ${utc(deadline)}`
        : "Closed. The prize amount goes back to the pool"
      : e.status === "published"
        ? payableAt > now
          ? `Winners on record. Prizes open in ${span(payableAt - now)}`
          : "Winners on record. Prizes can be claimed"
        : "Closed. The prize amount is back in the pool";

  async function claim() {
    await tx.run("Claim prize", async ({ send }) => {
      await send({ address: pool, abi: poolAbi, functionName: "claim", args: [BigInt(e.id)] });
      return `${assetAmount(prize, meta)} went to your wallet.`;
    });
  }

  return (
    <li className="cm-event">
      <div className="cm-event-main">
        <div>
          <strong>{kindName(e.kind, e.kindName)}</strong>
          <span>{status}</span>
        </div>
        <span className="cm-amount">{assetAmount(big(e.amount), meta) || "…"}</span>
      </div>
      {e.winners.length > 0 ? (
        <ol className="cm-winners">
          {e.winners.map((w) => (
            <li key={w.address}>
              <span className="mono">{sameAddr(w.address, address) ? "You" : mask(w.address)}</span>
              <span className="mono">{assetAmount(big(w.amount), meta)}</span>
              <span>{w.paid ? "Paid" : ""}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {prize > 0n ? (
        <div className="rc-claim cm-claim">
          <div>
            <p className="rc-claim-label">{claimed ? "Prize collected" : "Prize for this wallet"}</p>
            <p className="rc-claim-value">{assetAmount(prize, meta)}</p>
          </div>
          {claimed ? null : (
            <button className="primary" type="button" disabled={!ready || Boolean(tx.busy) || payableAt > now} onClick={() => void claim()}>
              {payableAt > now ? `Opens in ${span(payableAt - now)}` : tx.busy ? "Claiming…" : "Claim"}
            </button>
          )}
        </div>
      ) : null}
      <NoticeLine notice={tx.notice} />
    </li>
  );
}

function Board({ cfg, data, loading, meta }: { cfg: CommunityConfig; data?: RewardsResponse; loading: boolean; meta: (a: string) => AssetMeta | undefined }) {
  const { connected } = useWallet();
  const list = data?.achievements ?? [];
  const held = (asset: string) => {
    if (sameAddr(asset, cfg.addresses.orry)) return false;
    const p = data?.pool.find((x) => sameAddr(x.asset, asset));
    return !p || big(p.free) + big(p.locked) === 0n;
  };
  return (
    <section className="rc-panel" aria-label="Achievement Board">
      <div className="rc-panel-head">
        <h2>Achievement Board</h2>
        <p>Each achievement carries one fixed reward per wallet, paid in order of completion. The recipient list follows that same order.</p>
      </div>
      {!cfg.addresses.achievements ? (
        <p className="rc-muted">Achievements: {COMING_SOON}.</p>
      ) : loading ? (
        <p className="rc-muted">…</p>
      ) : list.length === 0 ? (
        <p className="rc-muted">Achievements are listed here once the first one starts.</p>
      ) : (
        <ul className="cm-achievements">
          {list.map((a) => (
            <AchievementRow key={a.id} cfg={cfg} a={a} meta={meta(a.asset)} held={held(a.asset)} />
          ))}
        </ul>
      )}
      {!connected && list.length > 0 ? (
        <div className="rc-connect">
          <p>Claiming a completed achievement needs a connected wallet.</p>
          <WalletButton />
        </div>
      ) : null}
    </section>
  );
}

function AchievementRow({ cfg, a, meta, held }: { cfg: CommunityConfig; a: CommunityAchievement; meta?: AssetMeta; held: boolean }) {
  const { address, ready } = useWallet();
  const now = useNow(5000);
  const tx = useCommunityTx();
  const [showRecipients, setShowRecipients] = useState(false);
  const [agentIn, setAgentIn] = useState("");
  const board = cfg.addresses.achievements as Address;
  const me = address ?? ("0x0000000000000000000000000000000000000000" as Address);
  const verifier = a.verifier && !isZeroAddr(a.verifier) ? (a.verifier as Address) : undefined;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: board, abi: orryAchievementsAbi, functionName: "claimed", args: [BigInt(a.id), me] },
      { address: board, abi: orryAchievementsAbi, functionName: "listedAt", args: [BigInt(a.id), me] },
    ],
    query: { enabled: Boolean(address) },
  });
  const condition = useReadContracts({
    allowFailure: true,
    contracts: verifier
      ? [
          { address: verifier, abi: verifierAbi, functionName: "attestor" },
          { address: verifier, abi: verifierAbi, functionName: "minStakeUsd" },
        ]
      : [],
    query: { enabled: Boolean(verifier), staleTime: Infinity },
  });
  const agentSubject = needsAgentId(condition.data) && /^\d+$/.test(agentIn) ? keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(agentIn)])) : undefined;
  const subject = useReadContracts({
    allowFailure: true,
    contracts: agentSubject ? [{ address: board, abi: orryAchievementsAbi, functionName: "subjectClaimedBy", args: [BigInt(a.id), agentSubject] }] : [],
    query: { enabled: Boolean(agentSubject) },
  });
  const agentTaken = subject.data?.[0]?.status === "success" && !isZeroAddr(subject.data[0].result as string);
  const claimed = reads.data?.[0]?.status === "success" ? Boolean(reads.data[0].result) : false;
  const listedAt = reads.data?.[1]?.status === "success" ? Number(reads.data[1].result as bigint) : 0;
  const needsAgent = condition.data?.[0]?.status === "success";
  const minStake = condition.data?.[1]?.status === "success" ? (condition.data[1].result as bigint) : undefined;
  const deadline = time(a.deadline);
  const ended = a.closed || deadline <= now;
  const claimableAt = listedAt > 0 ? listedAt + cfg.checkWindowSeconds : 0;
  const agentId = /^\d+$/.test(agentIn) ? BigInt(agentIn) : undefined;

  const how = verifier
    ? needsAgent
      ? "For owners of an agent verified by Orrery, one reward per agent. Claim with the agent ID."
      : minStake !== undefined
        ? `For wallets with ${usd(minStake)} or more earning in Stake. Claim once that holds.`
        : "The condition is checked on chain when you claim."
    : `Orrery records each wallet that completes it. A listed wallet claims${cfg.checkWindowSeconds > 0 ? ` ${period(cfg.checkWindowSeconds)}` : ""} after its entry.`;

  async function claim() {
    const label = "Claim reward";
    await tx.run(label, async ({ send }) => {
      if (verifier) {
        const data = needsAgent && agentId !== undefined ? encodeAbiParameters([{ type: "uint256" }], [agentId]) : "0x";
        await send({ address: board, abi: achievementsAbi, functionName: "claim", args: [BigInt(a.id), data] });
      } else {
        await send({ address: board, abi: achievementsAbi, functionName: "claimListed", args: [BigInt(a.id)] });
      }
      return `${assetAmount(big(a.rewardPerUser), meta)} went to your wallet.`;
    });
  }

  let action: ReactNode = null;
  if (held) action = <span className="cm-state">{COMING_SOON}</span>;
  else if (claimed) action = <span className="cm-state">Claimed</span>;
  else if (ended || !address) action = null;
  else if (verifier) {
    action = (
      <div className="cm-claim-row">
        {needsAgent ? (
          <div className="rc-inline">
            <label className="cm-label" htmlFor={`cm-agent-${a.id}`}>
              Agent ID
            </label>
            <input id={`cm-agent-${a.id}`} inputMode="numeric" autoComplete="off" placeholder="1" value={agentIn} onChange={(e) => setAgentIn(e.target.value.replace(/\D/g, ""))} />
          </div>
        ) : null}
        <button className="primary" type="button" disabled={!ready || Boolean(tx.busy) || (needsAgent && (agentId === undefined || agentTaken))} onClick={() => void claim()}>
          {tx.busy ? "Claiming…" : "Claim"}
        </button>
        {agentTaken ? <span className="cm-state">This agent&apos;s reward is already claimed.</span> : null}
      </div>
    );
  } else if (listedAt > 0) {
    action =
      claimableAt > now ? (
        <span className="cm-state">Opens in {span(claimableAt - now)}</span>
      ) : (
        <button className="primary" type="button" disabled={!ready || Boolean(tx.busy)} onClick={() => void claim()}>
          {tx.busy ? "Claiming…" : "Claim"}
        </button>
      );
  }

  return (
    <li className="cm-achievement">
      <div className="cm-event-main">
        <div>
          <strong>{kindName(a.kind, a.kindName)}</strong>
          <span>
            {how}
            {needsAgent && !claimed && !ended ? (
              <>
                {" "}
                <Link className="cm-link" href="/dashboard/agents">
                  Verify an agent
                </Link>
              </>
            ) : null}
          </span>
          <span>{ended ? "Closed" : `Runs until ${utc(deadline)}`}</span>
        </div>
        <div className="cm-reward">
          <span className="cm-amount">{held ? COMING_SOON : assetAmount(big(a.rewardPerUser), meta) || "…"}</span>
          {held ? null : <small>each wallet</small>}
        </div>
      </div>
      <div className="cm-achievement-foot">
        <button type="button" className="cm-link" aria-expanded={showRecipients} onClick={() => setShowRecipients((s) => !s)}>
          {showRecipients ? "Hide the list" : "Recipients"}
        </button>
        {action}
      </div>
      {showRecipients ? <Recipients id={a.id} meta={meta} /> : null}
      <NoticeLine notice={tx.notice} />
    </li>
  );
}

function Recipients({ id, meta }: { id: number; meta?: AssetMeta }) {
  const q = useRecipients(id, true);
  const rows = q.data?.recipients ?? [];
  if (q.isLoading) return <p className="rc-muted">…</p>;
  if (rows.length === 0) return <p className="rc-muted">{q.isError ? "The list loads in a moment." : "Wallets are listed here as they complete it."}</p>;
  return (
    <table className="rc-table cm-recipients">
      <thead>
        <tr>
          <th scope="col" className="rank">Order</th>
          <th scope="col">Address</th>
          <th scope="col">Completed</th>
          <th scope="col" className="num">Reward</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.rank}-${r.address}`}>
            <td className="rank mono">{r.rank}</td>
            <td className="mono">{mask(r.address)}</td>
            <td className="mono">{utc(time(r.completedAt))}</td>
            <td className="num mono">{assetAmount(big(r.amount), meta)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MostActive() {
  const q = useMostActive(true);
  const d = q.data;
  const rows = d?.rows ?? [];
  return (
    <section className="rc-panel rc-board" aria-label="Most active wallets · 7 days">
      <div className="rc-panel-head">
        <h2>Most active wallets · 7 days</h2>
        <p>
          Sorted by protocol fees paid in USD across the past 7 days, taken from chain records.
          {d?.from && d?.to ? ` ${utc(time(d.from))} to ${utc(time(d.to))}.` : ""}
        </p>
        {d?.rules ? (
          <details className="cm-rules">
            <summary>How the ranking is computed</summary>
            <pre className="mono">{prettyRules(d.rules)}</pre>
          </details>
        ) : null}
      </div>
      {q.isLoading ? (
        <p className="rc-muted">…</p>
      ) : rows.length === 0 ? (
        <p className="rc-muted">{q.isError ? "The ranking loads in a moment." : "Wallets are ranked here as fees are paid this week."}</p>
      ) : (
        <table className="rc-table">
          <thead>
            <tr>
              <th scope="col" className="rank">Rank</th>
              <th scope="col">Address</th>
              <th scope="col" className="num">Fees paid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.rank}-${r.address}`} className={r.rank <= 3 ? "is-top" : undefined}>
                <td className="rank mono">{r.rank}</td>
                <td className="mono">{mask(r.address)}</td>
                <td className="num mono" data-label="Fees paid">
                  {usd(big(r.feesUsd))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d?.rulesHash ? <p className="cm-hash mono">Hash of the rules · {d.rulesHash}</p> : null}
    </section>
  );
}

function prettyRules(rules: string): string {
  try {
    return JSON.stringify(JSON.parse(rules), null, 2);
  } catch {
    return rules;
  }
}

/** True when the verifier answered `attestor()`: the VerifiedAgentVerifier, whose claims carry an agent ID. */
function needsAgentId(data: readonly { status: string }[] | undefined): boolean {
  return data?.[0]?.status === "success";
}
