"use client";

import { use, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isAddress } from "viem";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { PageHead } from "@/components/PageHead";
import { Record } from "@/components/Record";
import { deployed } from "@/lib/config";
import { useAgentView } from "@/lib/lens";

export default function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = use(params);
  const account = useSearchParams().get("account") ?? "";
  const valid = /^\d+$/.test(agentId) && isAddress(account);
  const { data, isLoading, error } = useAgentView(valid ? BigInt(agentId) : undefined, account);
  const router = useRouter();
  const [accIn, setAccIn] = useState(account);
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="signer-main">
        <PageHead
          kicker="Agent chart"
          title={`Agent #${agentId}`}
          lead={account ? <p className="mono">paying from {account}</p> : null}
          art="agent-tag"
        />
        {!valid ? (
          <>
            <PageGuide
              audience="Anyone who wants to see what an AI agent may spend, and the account it spends from."
              steps={[
                { title: "Get the account", text: "The agent pays from a Safe. Its operator can give you the address, and every signed reading names it." },
                { title: "Paste it below", text: "The chart is drawn from chain state as the page loads." },
                { title: "Read the orbit", text: "Every cap, today's spend, the allowed calls, verification status and the most recent endpoint probe." },
              ]}
            />
            <form className="panel lookup-form" onSubmit={(e) => { e.preventDefault(); if (/^\d+$/.test(agentId) && isAddress(accIn.trim())) router.push(`/agent/${agentId}?account=${accIn.trim()}`); }}>
              <h2>Which Safe pays for agent #{agentId}?</h2>
              <div className="row">
                <label className="field">Account<input value={accIn} onChange={(e) => setAccIn(e.target.value)} placeholder="Safe address, 0x…" spellCheck={false} /></label>
                <button className="primary" type="submit" disabled={!isAddress(accIn.trim())}>Open chart</button>
              </div>
            </form>
          </>
        )
          : !deployed ? <div className="panel"><h2>Readings start soon</h2><p>Agent charts show here as soon as the contracts go live on this network.</p></div>
          : isLoading ? <div className="panel"><h2>Reading chain state</h2></div>
          : error || !data ? <div className="panel"><h2>Reading incomplete</h2><p>Reload the page in a moment.</p></div>
          : <Record view={data} />}
      </main>
      <Footer />
    </div>
  );
}
