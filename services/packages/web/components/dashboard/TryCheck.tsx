"use client";

import { useState } from "react";
import { isAddress, recoverTypedDataAddress, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { CHECK_VERSIONS, checkDomain, checkTypesFor, orreryAttestorAbi, type CheckVersion } from "@orrery/shared";
import { parseCheck } from "@orrery/sdk";
import { ADDRESSES, API_URL, activeChain } from "@/lib/config";
import { STATUS, short, usdg } from "@/lib/format";
import { Rows } from "./ui";

/**
 * One signed check from the browser, with the key the page just issued or one pasted in: the same request a server
 * sends, and the same verification (signature recovered, signer checked against the attestor on-chain). It spends an
 * included check or credits like any other check.
 */
export function TryCheck({ apiKey, onChecked }: { apiKey: string | null; onChecked?: () => void }) {
  const pub = usePublicClient();
  const [key, setKey] = useState("");
  const [payer, setPayer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ result: ReturnType<typeof parseCheck>; verified: boolean; signer: string } | null>(null);
  const k = key || apiKey || "";

  async function run() {
    if (!API_URL || !k || !isAddress(payer) || !pub || !ADDRESSES.attestor) return;
    setBusy(true);
    setCheck(null);
    setError(null);
    try {
      const r = await fetch(`${API_URL}/v1/check/by-signer/${payer}`, { headers: { authorization: `Bearer ${k}` } });
      const body = (await r.json()) as { result?: Record<string, unknown>; signature?: Hex; domain?: { version?: string }; error?: string };
      if (!r.ok || !body.result || !body.signature) throw new Error(body.error ?? "No result came back from the check.");
      const result = parseCheck(body.result);
      // only the version comes from the response; the name, chain and attestor are this page's own
      const version = (CHECK_VERSIONS as readonly string[]).includes(body.domain?.version ?? "1") ? ((body.domain?.version ?? "1") as CheckVersion) : null;
      if (!version) throw new Error("This page cannot read the check's version.");
      const signer = await recoverTypedDataAddress({ domain: checkDomain(activeChain.id, ADDRESSES.attestor, version), types: checkTypesFor(version), primaryType: "CheckResult", message: result as never, signature: body.signature });
      const verified = await pub.readContract({ address: ADDRESSES.attestor, abi: orreryAttestorAbi, functionName: "isCheckSigner", args: [signer] });
      setCheck({ result, verified, signer });
      onChecked?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No result came back from the check.");
    } finally {
      setBusy(false);
    }
  }

  const cap = check?.result.caps[0];
  return (
    <>
      <div className="cp-try">
        <label>
          API key
          <input value={k} onChange={(e) => setKey(e.target.value.trim())} placeholder="or_…" spellCheck={false} autoComplete="off" />
        </label>
        <label>
          Paying address
          <input value={payer} onChange={(e) => setPayer(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
        </label>
        <button className="cp-btn cp-btn-primary" type="button" disabled={!k || !isAddress(payer) || busy} onClick={() => void run()}>
          {busy ? "Checking" : "Send a signed check"}
        </button>
      </div>
      {error ? <p className="cp-note is-error" role="alert">{error}</p> : null}
      {check ? (
        <Rows
          rows={[
            ["Session", STATUS[Number(check.result.status)] ?? "Unknown"],
            ["Signature", check.verified ? `Valid · check signer ${short(check.signer)}` : "Signed by a key that is not an active check signer"],
            ["Account", <span key="a" className="mono">{short(check.result.account)}</span>],
            ["USDG today", cap ? `${usdg(cap.spentToday)} spent of ${usdg(cap.perDay)} · ${usdg(cap.perTx)} per payment` : "No caps"],
            ["Endpoints", check.result.endpointsLive ? "Live" : "Not seen live"],
            ["Valid until", `${new Date(Number(check.result.validUntil) * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`],
          ]}
        />
      ) : null}
    </>
  );
}
