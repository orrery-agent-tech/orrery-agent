"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { orreryLensAbi } from "@orrery/shared";
import type { ContractFunctionReturnType } from "viem";
import { STATUS, duration, isZero, short, usdg } from "@/lib/format";
import { ADDRESSES } from "@/lib/config";

type View = ContractFunctionReturnType<typeof orreryLensAbi, "view", "checkBySigner">;

const KIND = ["Not recognised", "Safe · Safe7579 adapter"];

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function StatusPill({ status }: { status: number }) {
  const name = STATUS[status] ?? "Unknown";
  return <span className={`pill-status ${name.toLowerCase().split(" ")[0]}`}>{name}</span>;
}

/** The public on-chain record of one session, read through OrreryLens. */
export function Record({ view }: { view: View }) {
  const now = useNow();
  if (isZero(view.account)) {
    return (
      <div className="panel">
        <h2>Nothing on record for this address</h2>
        <p>This address has never signed for an Orrery agent, so its payments follow no Orrery bounds.</p>
      </div>
    );
  }
  const windowLeft = Number(view.validFor) - now;
  const isUsdg = (t: Address) => ADDRESSES.usdg && t.toLowerCase() === ADDRESSES.usdg.toLowerCase();
  return (
    <div className="signer-layout">
      <section className="signer-overview">
        <div className="overview-head">
          <div className="big-symbol">⌁</div>
          <div>
            <StatusPill status={view.status} />
            <h2>{short(view.signer)}</h2>
            <p className="mono">{view.signer}</p>
          </div>
        </div>
        <dl className="identity-list">
          <div><dt>Account</dt><dd>{view.account}</dd></div>
          <div><dt>Agent</dt><dd>#{view.agentId.toString()}</dd></div>
          <div><dt>Agent owner</dt><dd>{isZero(view.owner) ? "Not found" : view.owner}</dd></div>
          <div><dt>Tied to this account</dt><dd>{view.bound ? "Yes" : "No"}</dd></div>
          <div><dt>Module installed</dt><dd>{view.installed ? "Yes" : "No"}</dd></div>
          <div><dt>Account kind</dt><dd>{KIND[view.accountKind] ?? "Not recognised"}</dd></div>
          <div><dt>Other access on this account</dt><dd>{view.otherAccountModules || view.signerIsAccountOwner || view.signerHasCode ? "Present" : "None found"}</dd></div>
          <div><dt>Verified</dt><dd>{view.verified ? "Yes" : "No"}</dd></div>
          <div><dt>Last probe</dt><dd>{view.attestation.observedAt > 0n ? `${new Date(Number(view.attestation.observedAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC · ${view.attestation.endpointsLive ? "endpoints responding" : "endpoints not responding"}` : "None"}</dd></div>
        </dl>
      </section>
      <section className="signer-caps">
        <h2>Caps</h2>
        {view.caps.map((c) => {
          const pct = c.perDay > 0n ? Number((c.spentToday * 10000n) / c.perDay) / 100 : 0;
          const unit = isUsdg(c.token) ? "USDG" : isZero(c.token) ? "ETH" : short(c.token);
          const fmt = (v: bigint) => (isUsdg(c.token) ? usdg(v) : v.toString());
          return (
            <div key={c.token}>
              <div className="cap-row"><span>{unit} per payment</span><strong>{fmt(c.perTx)}</strong></div>
              <div className="cap-row"><span>{unit} per day</span><strong>{fmt(c.perDay)}</strong></div>
              <div className="cap-row"><span>{unit} float ceiling</span><strong>{fmt(c.floatMax)}</strong></div>
              <div className="cap-row"><span>{unit} spent today</span><strong>{fmt(c.spentToday)}</strong></div>
              <span className="spend-track"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
            </div>
          );
        })}
        <div className="targets">
          <h3>Allowed calls</h3>
          {view.targets.length === 0 ? <p>None. The one move open to this signer is a float top up.</p> : view.targets.map((t) => (
            <div className="target-row" key={`${t.target}${t.selector}`}>
              <span className="target-art">⌁</span>
              <div><strong className="mono">{short(t.target)}</strong><small>{t.selector}</small></div>
            </div>
          ))}
        </div>
        <div className="signer-bottom">
          <span>Increase delay {duration(view.increaseDelay)}</span>
          <span>{view.pendingReadyAt > 0n ? `Higher cap applies in ${duration(Number(view.pendingReadyAt) - now)}` : windowLeft > 0 ? `Caps stay fixed for at least ${duration(windowLeft)}` : "A cap change can apply now"}</span>
        </div>
      </section>
    </div>
  );
}
