"use client";

import Link from "next/link";
import { useState } from "react";
import { getAddress, parseAbi, toHex, type Abi, type Address } from "viem";
import { useConnection, usePublicClient, useSignTypedData } from "wagmi";
import {
  DATA_DATASETS,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  permit2Domain,
  permit2WitnessTypes,
  transferWithAuthorizationTypes,
  verifyDataResponse,
  type DataPaymentRequirements,
  type DataResponse,
  type DatasetId,
  type PaymentRequired,
} from "@orrery/shared";
import { API_URL, activeChain } from "@/lib/config";
import { short } from "@/lib/format";
import { dollars, useDataCatalog, useDataSigner } from "@/lib/data/api";
import { useTx } from "@/lib/orry/chain";
import { useReleases } from "@/lib/orry/releases";
import { ExitConnect, Fig, NoticeLine, OrryHead, Row } from "../orry/parts";

const erc20 = parseAbi(["function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
const n = (v: number | string) => Number(v).toLocaleString("en-US");

export function DataView() {
  const catalog = useDataCatalog();
  const signer = useDataSigner();
  const releases = useReleases();
  const pricing = catalog.data?.pricing;
  const [key, setKey] = useState("");
  return (
    <>
      <OrryHead
        kicker="Orrery Data"
        title="Chain data with a signature on every answer."
        lead={
          <p>
            Seven datasets, read from Robinhood Chain and from Orrery&apos;s own records. Orrery&apos;s data key signs each answer, so an agent can trace every
            figure to the block it was read at.
          </p>
        }
        reading={
          <dl className="rc-rows rc-rows-tight">
            <Row label="Per call">{pricing ? <Fig v={dollars(pricing.callUsd)} /> : <Fig />}</Row>
            <Row label="Per pack" hint={pricing ? `${n(pricing.packCalls)} calls` : undefined}>{pricing ? <Fig v={dollars(pricing.packUsd)} /> : <Fig />}</Row>
            <Row label="Data signer">{signer.data ? <code>{short(signer.data.signer as Address)}</code> : <Fig />}</Row>
          </dl>
        }
      />

      <section className="mc-sec">
        <h2>Datasets</h2>
        <p className="mc-note">Every record carries its block number. Event records also name the transaction and the log they come from.</p>
        <ul className="mc-dir">
          {(catalog.data?.datasets ?? []).map((d) => (
            <li key={d.id}>
              <div>
                <strong>{d.title}</strong>
                <p>{d.summary}</p>
              </div>
              <div className="mc-dir-meta">
                <span>{d.records === null ? "Read live, per call" : `${n(d.records)} ${d.records === 1 ? "record" : "records"}`}</span>
                <code>{d.id}</code>
              </div>
            </li>
          ))}
        </ul>
        {catalog.isLoading ? <dl className="rc-rows"><Row label="Datasets"><Fig /></Row></dl> : null}
      </section>

      {pricing ? <BuyCalls pricing={pricing} onKey={setKey} /> : null}
      <Query apiKey={key} onKey={setKey} signer={signer.data?.signer as Address | undefined} />

      <section className="mc-sec">
        <h2>Verify an answer</h2>
        <p className="mc-note">
          Each answer is EIP-712 typed data under the domain <code>Orrery Data</code>. The Orrery SDK hashes the records you got once more and compares the
          signature with the data signer{signer.data ? <> <code>{signer.data.signer}</code></> : null}.
        </p>
        <pre className="mc-code">
          <code>
            {[
              `import { verifyDataResponse } from "@orrery/sdk";`,
              ``,
              `const res = await fetch("${API_URL ?? "https://api.orreryagent.com"}/v1/data/datasets/agents", {`,
              `  headers: { authorization: \`Bearer \${apiKey}\` },`,
              `}).then((r) => r.json());`,
              `const { ok } = await verifyDataResponse(res, { signer: "${signer.data?.signer ?? "0x..."}" });`,
            ].join("\n")}
          </code>
        </pre>
      </section>

      {releases.isLive("mcp") ? <McpSection /> : null}

      {releases.isLive("data-providers") ? (
        <section className="mc-sec">
          <h2>Datasets from outside providers</h2>
          <p className="mc-note">
            Providers who stake ORRY publish their own x402 endpoints. <Link href="/data/providers">Browse the providers</Link>
          </p>
        </section>
      ) : null}
    </>
  );
}

function BuyCalls({ pricing, onKey }: { pricing: NonNullable<ReturnType<typeof useDataCatalog>["data"]>["pricing"]; onKey: (k: string) => void }) {
  const { address, isConnected, chainId } = useConnection();
  const { signTypedDataAsync } = useSignTypedData();
  const pub = usePublicClient();
  const tx = useTx();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | ""; text: string } | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const ready = isConnected && chainId === activeChain.id && address;
  const orryUsd = (BigInt(pricing.packUsd) * BigInt(10_000 - pricing.orryDiscountBps)) / 10_000n;

  async function buy(asset: "usdg" | "orry") {
    if (!API_URL || !address || !pub) return;
    setBusy(true);
    setNotice(null);
    const url = `${API_URL}/v1/data/packs`;
    try {
      const first = await fetch(url, { method: "POST" });
      const header = first.headers.get(HEADER_REQUIRED);
      if (first.status !== 402 || !header) throw new Error("Could not read the payment terms. Retry in a few seconds.");
      const required = decodeHeader<PaymentRequired>(header);
      const accepts = required.accepts as unknown as DataPaymentRequirements[];
      const req = accepts.find((a) => (asset === "orry" ? a.extra.assetTransferMethod === "permit2" : a.extra.assetTransferMethod === "eip3009"));
      if (!req) throw new Error(asset === "orry" ? "ORRY is not among the payment options here. Use USDG instead." : "USDG is not offered on this network.");
      const now = BigInt(Math.floor(Date.now() / 1000));
      let payload: unknown;
      if (asset === "usdg") {
        const auth = { from: getAddress(address), to: getAddress(req.payTo), value: BigInt(req.amount), validAfter: now - 60n, validBefore: now + BigInt(req.maxTimeoutSeconds), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
        const signature = await signTypedDataAsync({
          domain: { name: req.extra.name!, version: req.extra.version!, chainId: activeChain.id, verifyingContract: getAddress(req.asset) },
          types: transferWithAuthorizationTypes,
          primaryType: "TransferWithAuthorization",
          message: auth,
        });
        payload = {
          x402Version: X402_VERSION,
          resource: required.resource,
          accepted: req,
          payload: { signature, authorization: { ...auth, value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() } },
        };
      } else {
        const permit2 = getAddress(req.extra.permit2!);
        const allowance = await pub.readContract({ address: getAddress(req.asset), abi: erc20, functionName: "allowance", args: [address, permit2] });
        if (allowance < BigInt(req.amount)) {
          setNotice({ tone: "", text: "One approval lets Permit2 move ORRY for your payments." });
          const ok = await tx.run("Approve ORRY for Permit2", async ({ send }) => {
            await send({ address: getAddress(req.asset), abi: erc20 as Abi, functionName: "approve", args: [permit2, 2n ** 256n - 1n] });
          });
          if (!ok) return;
        }
        const nonce = BigInt(toHex(crypto.getRandomValues(new Uint8Array(31))));
        const deadline = now + BigInt(req.maxTimeoutSeconds);
        const signature = await signTypedDataAsync({
          domain: permit2Domain(activeChain.id, permit2),
          types: permit2WitnessTypes,
          primaryType: "PermitWitnessTransferFrom",
          message: { permitted: { token: getAddress(req.asset), amount: BigInt(req.amount) }, spender: getAddress(req.extra.proxy!), nonce, deadline, witness: { to: getAddress(req.payTo) } },
        });
        payload = {
          x402Version: X402_VERSION,
          accepted: req,
          payload: {
            signature,
            permit2Authorization: { from: getAddress(address), permitted: { token: getAddress(req.asset), amount: req.amount }, spender: getAddress(req.extra.proxy!), nonce: nonce.toString(), deadline: deadline.toString(), witness: { to: getAddress(req.payTo) } },
          },
        };
      }
      for (let i = 0; i < 15; i++) {
        const r = await fetch(url, { method: "POST", headers: { [HEADER_SIGNATURE]: encodeHeader(payload) } });
        if (r.status === 202) {
          setNotice({ tone: "", text: "Payment seen, waiting for confirmation." });
          await new Promise((res) => setTimeout(res, 2_000));
          continue;
        }
        const body = (await r.json()) as { account?: { calls: string; apiKey?: string }; granted?: string; error?: string };
        if (!r.ok) throw new Error(body.error ?? "The server did not accept the payment.");
        if (body.account?.apiKey) {
          setIssued(body.account.apiKey);
          onKey(body.account.apiKey);
        }
        setNotice({ tone: "ok", text: `Added ${n(body.granted ?? "0")} calls. This key now holds ${n(body.account?.calls ?? "0")}.` });
        return;
      }
      throw new Error("The payment has not confirmed yet. The call balance updates once it does.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setNotice({ tone: "error", text: /reject|denied/i.test(msg) ? "The wallet closed the request." : msg || "The purchase was not completed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mc-sec">
      <h2>Call packs</h2>
      <dl className="rc-rows">
        <Row label="USDG pack" hint={`${n(pricing.packCalls)} calls · paid to the Orrery treasury`}>{dollars(pricing.packUsd)}</Row>
        {pricing.orryPayTo ? (
          <Row label="ORRY pack" hint={`${pricing.orryDiscountBps / 100}% off · 70% burned, 30% to the Reward Pool`}>{dollars(orryUsd)}</Row>
        ) : null}
      </dl>
      {pricing.maxStakeDiscountBps > 0 ? <p className="mc-note">Staking ORRY adds calls to each pack, scaled by your fee tier.</p> : null}
      {!ready ? (
        <ExitConnect text={isConnected ? "Change your wallet to this network to buy a pack." : "Connect the paying wallet. The calls are kept under its address."} />
      ) : (
        <div className="mc-actions">
          <button className="primary" type="button" disabled={busy || Boolean(tx.busy)} onClick={() => void buy("usdg")}>
            Pay with USDG
          </button>
          {pricing.orryPayTo ? (
            <button className="secondary" type="button" disabled={busy || Boolean(tx.busy)} onClick={() => void buy("orry")}>
              Pay with ORRY
            </button>
          ) : null}
        </div>
      )}
      {issued ? (
        <div className="mc-address">
          <code>{issued}</code>
          <button type="button" className="quiet-button" onClick={() => void navigator.clipboard?.writeText(issued)}>
            Copy key
          </button>
        </div>
      ) : null}
      {issued ? <p className="mc-note">This API key covers checks and data. It appears only this once, so store it with your agent&apos;s settings.</p> : null}
      <NoticeLine notice={tx.busy ? tx.notice : notice} />
    </section>
  );
}

function Query({ apiKey, onKey, signer }: { apiKey: string; onKey: (k: string) => void; signer?: Address }) {
  const [dataset, setDataset] = useState<DatasetId>("chain-health");
  const [answer, setAnswer] = useState<{ res: DataResponse; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | ""; text: string } | null>(null);

  async function run() {
    if (!API_URL || !apiKey) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch(`${API_URL}/v1/data/datasets/${dataset}?limit=5`, { headers: { authorization: `Bearer ${apiKey}` } });
      const body = (await r.json()) as DataResponse & { error?: string };
      if (r.status === 402) throw new Error("This key has used all its calls. A pack above adds more.");
      if (!r.ok) throw new Error(body.error ?? "The query was not completed.");
      const v = await verifyDataResponse(body, { signer, chainId: activeChain.id });
      setAnswer({ res: body, ok: v.ok });
      setNotice({ tone: v.ok ? "ok" : "error", text: v.ok ? `Signature verified · ${n(body.account?.calls ?? "0")} calls remain.` : "This answer failed verification." });
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "The query was not completed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mc-sec">
      <h2>Read a dataset</h2>
      <p className="mc-note">Each answer uses one call. Paste an Orrery API key, or buy a pack above and a key is issued.</p>
      <div className="mc-form">
        <label className="field">
          API key
          <input value={apiKey} onChange={(e) => onKey(e.target.value.trim())} placeholder="or_" autoComplete="off" spellCheck={false} />
        </label>
        <label className="field">
          Dataset
          <select value={dataset} onChange={(e) => setDataset(e.target.value as DatasetId)}>
            {DATA_DATASETS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mc-actions">
        <button className="primary" type="button" disabled={busy || !apiKey} onClick={() => void run()}>
          Send query
        </button>
      </div>
      <NoticeLine notice={notice} />
      {answer ? (
        <pre className="mc-code">
          <code>{JSON.stringify({ dataset: answer.res.dataset, asOfBlock: answer.res.asOfBlock, records: answer.res.records, signer: answer.res.signer, signature: answer.res.signature }, null, 2)}</code>
        </pre>
      ) : null}
    </section>
  );
}

function McpSection() {
  return (
    <section className="mc-sec">
      <h2>From an MCP client</h2>
      <p className="mc-note">
        <code>@orrery/mcp</code> exposes checks, agent records and Orrery Data as MCP tools. Every tool states its price, and a payment above the amount you set
        goes through only once the call confirms it. The session key stays in a file on the agent&apos;s own machine.
      </p>
      <pre className="mc-code">
        <code>
          {[
            `{`,
            `  "mcpServers": {`,
            `    "orrery": {`,
            `      "command": "npx",`,
            `      "args": ["-y", "@orrery/mcp"],`,
            `      "env": { "ORRERY_API_KEY": "or_...", "ORRERY_AGENT_KEY_FILE": "/path/to/agent.key" }`,
            `    }`,
            `  }`,
            `}`,
          ].join("\n")}
        </code>
      </pre>
    </section>
  );
}
