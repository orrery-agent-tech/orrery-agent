"use client";

import { useState } from "react";
import type { Abi, Address } from "viem";
import { useReadContracts, useSignMessage } from "wagmi";
import { iMerchantSplitterAbi, iMerchantSplitterFactoryAbi } from "@orrery/shared";
import { API_URL, ADDRESSES, CHAIN_ID } from "@/lib/config";
import { short } from "@/lib/format";
import { pct, useDirectory, useMerchant, useSupported, type MerchantView } from "@/lib/merchants";
import { get, post } from "@/lib/orry/api";
import { useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { amount } from "@/lib/orry/format";
import { useReleases } from "@/lib/orry/releases";
import { ExitConnect, Fig, NoticeLine, OrryHead, Row } from "../orry/parts";

const usd = (v: string | bigint) => `$${amount(BigInt(v), { decimals: 6, frac: 2 })}`;

/** Tokens a payment address forwards, with their display decimals. */
function tokens(): { address: Address; symbol: string; decimals: number }[] {
  const out: { address: Address; symbol: string; decimals: number }[] = [];
  if (ADDRESSES.usdg) out.push({ address: ADDRESSES.usdg, symbol: "USDG", decimals: 6 });
  if (ORRY.token) out.push({ address: ORRY.token, symbol: "ORRY", decimals: 18 });
  return out;
}

export function MerchantsView() {
  const { address, connected } = useWallet();
  const releases = useReleases();
  const me = useMerchant(address);
  return (
    <>
      <OrryHead
        kicker="Merchants"
        title={ORRY.token ? "Agents pay you in USDG or ORRY." : "Agents pay you in USDG."}
        lead={
          <p>
            Orrery settles each x402 payment into your payment address, takes {pct(20)}, and sends the remainder on to your wallet.
            {ORRY.token ? " A stake in ORRY brings that fee down." : null}
          </p>
        }
      />
      {!address ? (
        <ExitConnect text={connected ? "Your payment address shows once the wallet is on this network." : "Connect the wallet that will receive the payments."} />
      ) : me.data ? (
        <PaymentAddress view={me.data} onChange={() => void me.refetch()} />
      ) : (
        <section className="mc-sec">
          <h2>Payment address</h2>
          <dl className="rc-rows"><Row label="Payment address"><Fig /></Row></dl>
        </section>
      )}
      {address && me.data?.created ? <Profile view={me.data} onSaved={() => void me.refetch()} /> : null}
      <Integration payTo={me.data?.splitter} />
      {releases.isLive("merchant-badge") ? <Directory /> : null}
    </>
  );
}

export function PaymentAddress({ view, onChange }: { view: MerchantView; onChange: () => void }) {
  const tx = useTx();
  const list = tokens();
  const preview = useReadContracts({
    allowFailure: true,
    contracts: list.map((t) => ({ address: view.splitter, abi: iMerchantSplitterAbi as Abi, functionName: "previewForward", args: [t.address] })),
    query: { enabled: view.created, refetchInterval: 12_000 },
  });
  const fee = Math.round((view.feeBps * (10_000 - view.discountBps)) / 10_000);
  const [copied, setCopied] = useState(false);

  async function create() {
    if (!ORRY.splitterFactory) return;
    const ok = await tx.run("Payment address setup", async ({ send }) => {
      await send({ address: ORRY.splitterFactory!, abi: iMerchantSplitterFactoryAbi as Abi, functionName: "create", args: [view.merchant] });
      return "Payment address on record. It can take payments now.";
    });
    if (ok) onChange();
  }
  async function forward(token: Address, symbol: string) {
    const ok = await tx.run(`Forward ${symbol}`, async ({ send }) => {
      await send({ address: view.splitter, abi: iMerchantSplitterAbi as Abi, functionName: "forward", args: [token] });
      return `${symbol} forwarded. It lands in your wallet with this block.`;
    });
    if (ok) onChange();
  }

  return (
    <section className="mc-sec">
      <h2>Payment address</h2>
      <p className="mc-note">Set it as <code>payTo</code> on each x402 price you publish. Your wallet owns it, and it forwards only to your wallet.</p>
      <div className="mc-address">
        <code>{view.splitter}</code>
        <button
          type="button"
          className="quiet-button"
          onClick={() => {
            void navigator.clipboard?.writeText(view.splitter).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <dl className="rc-rows">
        <Row label="Status">{view.created ? "Taking payments" : "Not created"}</Row>
        <Row label="Orrery fee" hint={view.discountBps > 0 ? `${pct(view.discountBps)} lower thanks to your stake` : undefined}>
          {pct(fee)}
        </Row>
        {ORRY.token ? <Row label="ORRY staked">{usd(view.stakeUsd)}</Row> : null}
        {view.created
          ? list.map((t, i) => {
              const r = preview.data?.[i];
              const v = r?.status === "success" ? (r.result as readonly [bigint, bigint, number]) : undefined;
              return (
                <Row key={t.address} label={`${t.symbol} to forward`} hint={v && v[0] + v[1] > 0n ? `${amount(v[1], { decimals: t.decimals, frac: 4 })} ${t.symbol} fee` : undefined}>
                  {v === undefined ? <Fig /> : `${amount(v[0] + v[1], { decimals: t.decimals, frac: t.decimals === 6 ? 2 : 4 })} ${t.symbol}`}
                </Row>
              );
            })
          : null}
        {view.settled30d.map((s) => {
          const t = list.find((x) => x.address.toLowerCase() === s.asset.toLowerCase());
          return (
            <Row key={s.asset} label={`${t?.symbol ?? short(s.asset)} received · 30 days`} hint={`${s.payments} ${s.payments === 1 ? "payment" : "payments"}`}>
              {amount(BigInt(s.amount), { decimals: t?.decimals ?? 18, frac: 2 })} {t?.symbol ?? ""}
            </Row>
          );
        })}
      </dl>
      <div className="mc-actions">
        {!view.created ? (
          <button className="primary" type="button" disabled={Boolean(tx.busy) || !ORRY.splitterFactory} onClick={() => void create()}>
            Set up payment address
          </button>
        ) : (
          list.map((t, i) => {
            const r = preview.data?.[i];
            const v = r?.status === "success" ? (r.result as readonly [bigint, bigint, number]) : undefined;
            const has = v !== undefined && v[0] + v[1] > 0n;
            return (
              <button key={t.address} className="secondary" type="button" disabled={Boolean(tx.busy) || !has} onClick={() => void forward(t.address, t.symbol)}>
                Send {t.symbol} to wallet
              </button>
            );
          })
        )}
      </div>
      {view.created ? <p className="mc-note">The Orrery keeper forwards balances on a schedule as well.{ORRY.token ? " Every fee paid in ORRY is burned." : null}</p> : null}
      <NoticeLine notice={tx.notice} />
    </section>
  );
}

export function Profile({ view, onSaved }: { view: MerchantView; onSaved: () => void }) {
  const { signMessageAsync } = useSignMessage();
  const [name, setName] = useState(view.profile?.name ?? "");
  const [url, setUrl] = useState(view.profile?.url ?? "");
  const [description, setDescription] = useState(view.profile?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | ""; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setNotice({ tone: "", text: "Your wallet asks you to sign a message." });
    try {
      const n = await get<{ nonce: string; message: string }>(`/v1/merchants/profile/nonce?address=${view.merchant}`);
      const signature = await signMessageAsync({ message: n.message });
      await post("/v1/merchants/profile", { merchant: view.merchant, nonce: n.nonce, signature, name, url, description });
      setNotice({ tone: "ok", text: "Profile on record." });
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setNotice({ tone: "error", text: /reject|denied/i.test(msg) ? "The wallet request was dismissed." : msg || "The profile did not save. Try saving once more." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mc-sec">
      <h2>Public profile</h2>
      <p className="mc-note">
        Appears on your merchant record
        {ORRY.token ? (view.badge ? " and listed in the directory" : `, and joins the directory when your stake reaches ${usd(view.badgeMinStakeUsd)}`) : null}. Saving
        asks for a signed message only, with no transaction and no gas.
      </p>
      <div className="mc-form">
        <label className="field">
          Name
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Link
          <input value={url} maxLength={200} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field mc-wide">
          What you sell to agents
          <textarea value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <div className="mc-actions">
        <button className="primary" type="button" disabled={busy || name.trim().length < 2} onClick={() => void save()}>
          Save profile
        </button>
      </div>
      <NoticeLine notice={notice} />
    </section>
  );
}

export function Integration({ payTo }: { payTo?: Address }) {
  const supported = useSupported();
  const kinds = supported.data?.kinds ?? [];
  const usdgKind = kinds.find((k) => k.extra.assetTransferMethod === "eip3009");
  const orryKind = kinds.find((k) => k.extra.assetTransferMethod === "permit2");
  const network = `eip155:${CHAIN_ID}`;
  const to = payTo ?? "<payment address>";
  const lines = [
    `// one x402 price per request, settled in USDG`,
    `{`,
    `  scheme: "exact",`,
    `  network: "${usdgKind?.network ?? network}",`,
    `  asset: "${usdgKind?.asset ?? ADDRESSES.usdg ?? ""}",`,
    `  amount: "10000", // 0.01 USDG, set your own`,
    `  payTo: "${to}",`,
    `  maxTimeoutSeconds: 120,`,
    `  extra: { name: "${usdgKind?.extra.name ?? ""}", version: "${usdgKind?.extra.version ?? ""}" },`,
    `}`,
  ];
  return (
    <section className="mc-sec">
      <h2>Charge from your API</h2>
      <p className="mc-note">
        Send your x402 middleware to the Orrery facilitator{API_URL ? <> at <code>{`${API_URL}/v1/x402`}</code></> : null}, and list prices whose <code>payTo</code> is
        your payment address. The verify and settle calls match the standard x402 facilitator API.
      </p>
      <pre className="mc-code"><code>{lines.join("\n")}</code></pre>
      {orryKind ? (
        <p className="mc-note">
          For ORRY prices, set <code>assetTransferMethod: &quot;permit2&quot;</code> and the proxy <code>{orryKind.extra.proxy}</code>. Each payment carries its own
          signed Permit2 message, which <code>signPermit2Payment</code> in the Orrery SDK prepares.
        </p>
      ) : null}
    </section>
  );
}

function Directory() {
  const { data, isLoading } = useDirectory(true);
  const list = data?.merchants ?? [];
  return (
    <section className="mc-sec">
      <h2>Directory</h2>
      <p className="mc-note">Merchants holding a profile and a badge level stake, sorted by stake.</p>
      {isLoading ? (
        <dl className="rc-rows"><Row label="Merchants"><Fig /></Row></dl>
      ) : list.length === 0 ? (
        <p className="mc-note">Merchants are listed here once they reach the badge level.</p>
      ) : (
        <ul className="mc-dir">
          {list.map((m) => (
            <li key={m.merchant}>
              <div>
                <strong>{m.name}</strong>
                {m.description ? <p>{m.description}</p> : null}
              </div>
              <div className="mc-dir-meta">
                {m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.url.replace(/^https:\/\//, "")}</a> : null}
                <code>{short(m.splitter)}</code>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
