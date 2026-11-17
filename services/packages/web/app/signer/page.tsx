"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { erc20Abi, getAddress, isAddress, isHash, parseEventLogs } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/config";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide, ResultPreview } from "@/components/PageGuide";
import { PageHead } from "@/components/PageHead";
import Link from "next/link";

export default function SignerSearch() {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const router = useRouter();
  const pub = usePublicClient();
  const input = v.trim();
  const valid = isAddress(input) || isHash(input);

  /**
   * An address opens its record. A transaction hash is read first: the payer is the sender of the USDG transfer inside
   * it. Over x402 a facilitator sends the transaction, so the transaction's own sender is the wrong address to check.
   */
  async function lookUp() {
    setNotice("");
    if (isAddress(input)) return router.push(`/signer/${input}`);
    if (!isHash(input) || !pub) return;
    setBusy(true);
    try {
      const r = await pub.getTransactionReceipt({ hash: input });
      const transfers = parseEventLogs({ abi: erc20Abi, logs: r.logs, eventName: "Transfer" });
      const paid = transfers.find((t) => ADDRESSES.usdg && t.address.toLowerCase() === ADDRESSES.usdg.toLowerCase()) ?? transfers[0];
      router.push(`/signer/${getAddress(paid ? paid.args.from : r.from)}`);
    } catch {
      setNotice("No transaction with that hash on this network. Confirm the hash, or paste the paying address instead.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="signer-main">
        <PageHead
          kicker="Signer readings"
          title="Read the orbit of any paying address."
          lead={<p>Paste the address behind a payment. Every value below comes from chain state at the moment you ask.</p>}
          art="signer-lookup"
        />
        <PageGuide
          audience="Merchants, and anyone an AI agent has paid in USDG."
          steps={[
            { title: "Bring the payment", text: "Paste the paying address or the payment's transaction hash. With a hash, the payer is taken from the USDG transfer it contains." },
            { title: "Read it here", text: "Free and open, no key required. Values come straight from chain state, and Orrery keeps no cached copy." },
            { title: "Read it from your service", text: <>Need a signed reading inside your own backend? Buy check credits and call <code>checkPayer</code>. <Link href="/dashboard/credits">Credits</Link></> },
          ]}
        />
        <div className="with-preview">
          <form className="panel lookup-form" onSubmit={(e) => { e.preventDefault(); void lookUp(); }}>
            <h2>Take a reading</h2>
            <div className="row">
              <label className="field">Payer address or payment hash<input value={v} onChange={(e) => setV(e.target.value)} placeholder="0x…" spellCheck={false} /></label>
              <button className="primary" type="submit" disabled={!valid || busy}>{busy ? "Reading" : "Read"}</button>
            </div>
            {notice ? <div className="notice error" role="status">{notice}</div> : null}
          </form>
          <ResultPreview
            title="What a reading contains"
            rows={[
              ["Session", "Active, paused or revoked state"],
              ["Agent", "ERC-8004 identity with owner"],
              ["Per payment", "Ceiling on any one payment"],
              ["Per day", "Daily cap beside today's spend"],
              ["Float ceiling", "Highest balance the signer may hold"],
              ["Endpoints", "Most recent probe of the agent's endpoints"],
            ]}
            foot="An address without an Orrery session says so in the first line, so a stranger stands out at once."
          />
        </div>
      </main>
      <Footer />
    </div>
  );
}
