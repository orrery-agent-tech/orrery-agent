"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Abi, Address } from "viem";
import { useReadContracts } from "wagmi";
import { iDataProviderRegistryAbi } from "@orrery/shared";
import { API_URL, ADDRESSES } from "@/lib/config";
import { short } from "@/lib/format";
import { dollars, useDataProviders } from "@/lib/data/api";
import { useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { ExitConnect, Fig, NoticeLine, OrryHead, Row } from "../orry/parts";

const abi = iDataProviderRegistryAbi as Abi;
const n = (v: number | string) => Number(v).toLocaleString("en-US");
const payments = (count: number) => (count === 0 ? "" : ` · ${n(count)} ${count === 1 ? "payment" : "payments"} over the last 30 days`);

export function ProvidersView() {
  const list = useDataProviders();
  const { address, connected } = useWallet();
  const min = list.data?.minStakeUsd;
  return (
    <>
      <OrryHead
        kicker="Data providers"
        title="Charge agents per call for your data."
        lead={
          <p>
            Stake ORRY worth at least {min ? dollars(min) : <Fig />} and your x402 endpoint goes on the list. Agents pay into your payment address, Orrery keeps
            1%, and the rest moves on to your wallet.
          </p>
        }
      />
      <section className="mc-sec">
        <h2>Providers</h2>
        {list.isLoading ? (
          <dl className="rc-rows"><Row label="Providers"><Fig /></Row></dl>
        ) : (list.data?.providers.filter((p) => p.active) ?? []).length === 0 ? (
          <p className="mc-note">Listed providers show here as they join.</p>
        ) : (
          <ul className="mc-dir">
            {list.data!.providers
              .filter((p) => p.active)
              .map((p) => (
                <li key={p.provider}>
                  <div>
                    <strong>{p.name}</strong>
                    {p.description ? <p>{p.description}</p> : null}
                    <p>
                      {dollars(p.priceUsdg)} per call · {dollars(p.stakeUsd)} staked
                      {payments(p.settled30d.reduce((a, s) => a + s.payments, 0))}
                    </p>
                  </div>
                  <div className="mc-dir-meta">
                    <a href={p.endpoint} target="_blank" rel="noreferrer">{p.endpoint.replace(/^https:\/\//, "")}</a>
                    <code>{short(p.splitter)}</code>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
      {!address ? (
        <section className="mc-sec">
          <h2>Your listing</h2>
          <ExitConnect text={connected ? "Change your wallet to this network to edit your listing." : "Connect the wallet your data payments go to."} />
        </section>
      ) : (
        <Listing provider={address} onChange={() => void list.refetch()} />
      )}
    </>
  );
}

function Listing({ provider, onChange }: { provider: Address; onChange: () => void }) {
  const tx = useTx();
  const registry = ORRY.dataRegistry!;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: registry, abi, functionName: "listing", args: [provider] },
      { address: registry, abi, functionName: "stakeUsdOf", args: [provider] },
      { address: registry, abi, functionName: "minStakeUsd" },
      { address: registry, abi, functionName: "splitterOf", args: [provider] },
      { address: registry, abi, functionName: "isActive", args: [provider] },
    ],
    query: { refetchInterval: 15_000 },
  });
  const listing = reads.data?.[0]?.status === "success" ? (reads.data[0].result as { listedAt: bigint; priceUsdg: bigint }) : undefined;
  const stake = reads.data?.[1]?.status === "success" ? (reads.data[1].result as bigint) : undefined;
  const min = reads.data?.[2]?.status === "success" ? (reads.data[2].result as bigint) : undefined;
  const splitter = reads.data?.[3]?.status === "success" ? (reads.data[3].result as Address) : undefined;
  const active = reads.data?.[4]?.status === "success" ? (reads.data[4].result as boolean) : undefined;
  const listed = Boolean(listing && listing.listedAt > 0n);
  const mine = useDataProviders().data?.providers.find((p) => p.provider.toLowerCase() === provider.toLowerCase());

  const [endpoint, setEndpoint] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("0.001");
  useEffect(() => {
    if (!mine) return;
    setEndpoint(mine.endpoint);
    setName(mine.name);
    setDescription(mine.description);
    setPrice(String(Number(mine.priceUsdg) / 1e6));
  }, [mine?.provider, mine?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const priceUnits = /^\d+(\.\d{1,6})?$/.test(price) ? BigInt(Math.round(Number(price) * 1e6)) : 0n;
  const valid = /^https:\/\/\S{4,192}$/.test(endpoint) && name.trim().length >= 2 && name.trim().length <= 40 && description.length <= 280 && priceUnits > 0n;
  const staked = stake !== undefined && min !== undefined && stake >= min;

  async function save() {
    const fn = listed ? "update" : "list";
    const ok = await tx.run(listed ? "Update listing" : "Publish listing", async ({ send }) => {
      await send({ address: registry, abi, functionName: fn, args: [endpoint, name.trim(), description, priceUnits] });
      return listed ? "Listing updated." : "Endpoint published.";
    });
    if (ok) {
      void reads.refetch();
      onChange();
    }
  }
  async function remove() {
    const ok = await tx.run("Remove listing", async ({ send }) => {
      await send({ address: registry, abi, functionName: "unlist", args: [] });
      return "Listing removed.";
    });
    if (ok) {
      void reads.refetch();
      onChange();
    }
  }

  return (
    <>
      <section className="mc-sec">
        <h2>Your listing</h2>
        <dl className="rc-rows">
          <Row label="Status">{listing === undefined ? <Fig /> : listed ? (active ? "Listed" : "Listed · stake under the minimum") : "Not listed"}</Row>
          <Row label="ORRY staked" hint={min !== undefined ? `${dollars(min)} minimum to list` : undefined}>{stake === undefined ? <Fig /> : dollars(stake)}</Row>
          <Row label="Payment address">{splitter ? <code>{splitter}</code> : <Fig />}</Row>
        </dl>
        {stake !== undefined && !staked ? (
          <p className="mc-note">
            <Link href="/stake">Stake ORRY</Link> up to the listing minimum.
          </p>
        ) : null}
        <div className="mc-form">
          <label className="field mc-wide">
            Endpoint
            <input value={endpoint} maxLength={200} placeholder="https://" onChange={(e) => setEndpoint(e.target.value.trim())} />
          </label>
          <label className="field">
            Name
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            USD per call
            <input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value.trim())} />
          </label>
          <label className="field mc-wide">
            Description
            <textarea value={description} maxLength={280} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <div className="mc-actions">
          <button className="primary" type="button" disabled={Boolean(tx.busy) || !valid || !staked} onClick={() => void save()}>
            {listed ? "Update listing" : "Publish listing"}
          </button>
          {listed ? (
            <button className="secondary" type="button" disabled={Boolean(tx.busy)} onClick={() => void remove()}>
              Remove listing
            </button>
          ) : null}
        </div>
        <NoticeLine notice={tx.notice} />
      </section>
      <section className="mc-sec">
        <h2>Settling payments at your endpoint</h2>
        <p className="mc-note">
          Reply with x402 <code>exact</code> terms that set <code>payTo</code> to your payment address, then settle through Orrery&apos;s data facilitator
          {API_URL ? <> at <code>{`${API_URL}/v1/data/x402`}</code></> : null}. Agents can pay in USDG{ADDRESSES.usdg ? <> (<code>{short(ADDRESSES.usdg)}</code>)</> : null} or in ORRY through Permit2.
          Orrery&apos;s keeper moves the balance of your payment address on to your wallet, and fees paid in ORRY are burned.
        </p>
      </section>
    </>
  );
}
