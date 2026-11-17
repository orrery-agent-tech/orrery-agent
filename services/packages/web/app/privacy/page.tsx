import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageHead } from "@/components/PageHead";
import { X_HANDLE, X_URL } from "@/components/social";

export const metadata = {
  title: "Orrery · Privacy Policy",
  description: "The records Orrery holds when you use orreryagent.com or the Orrery API, and the reason for each.",
};

const UPDATED = "9 November 2026";

type Section = { id: string; title: string; body: ReactNode };

/** The contact line names only the channels that are configured; with none, it points to the site. */
function Contact() {
  const channels: ReactNode[] = [];
  if (X_URL) channels.push(<>on X at <a href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE}</a></>);
  return (
    <p>
      {channels.length ? <>Write to the team {channels[0]}{channels[1] ? <> or {channels[1]}</> : null}. </> : <>Write to the team through the contact channels published on orreryagent.com. </>}
      The rules for using the service sit in the <Link href="/terms">Terms of Use</Link>.
    </p>
  );
}

const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "Overview",
    body: (
      <>
        <p>
          This policy applies to orreryagent.com and the Orrery API. Orrery identifies people by wallet address. Each record the service holds is described below, with the reason it is held.
        </p>
        <p>Orrery never asks for your name, email, phone number or a password, and the website carries no advertising or analytics trackers.</p>
      </>
    ),
  },
  {
    id: "chain",
    title: "Data read from the chain",
    body: (
      <>
        <p>
          The service reads events emitted by the Orrery contracts and the ORRY pools on Robinhood Chain: addresses, amounts, transaction hashes and timestamps. From them it builds running totals for each address, for example stakes, Earn shares, and amounts claimed and earned.
        </p>
        <p>Those totals feed your account views and the leaderboard. All of them derive from records anyone can already read on Robinhood Chain.</p>
      </>
    ),
  },
  {
    id: "credits",
    title: "Credits and API keys",
    body: (
      <>
        <p>If an address signs in for an API key, purchases check credits or purchases the platform plan, the service records:</p>
        <ul>
          <li>the wallet address, with its credit balance;</li>
          <li>the end date of its platform plan, if it holds one;</li>
          <li>each payment: its amount, its status and its transaction hash;</li>
          <li>for an ORRY payment, the signed price quote, meaning the buyer address, the pack count or agent id, and the ORRY amount;</li>
          <li>how many checks the address runs in each month, and how many of those fell within the included allowance, so the included checks and the price tier can be applied.</li>
        </ul>
        <p>A daily count of checks across every address is kept as well, with no address attached to it. A price quote that goes unused is deleted one day after its expiry.</p>
        <p>
          An API key is held only as a SHA-256 hash tied to your address, and you see the full key a single time, when it is issued. Signing in for a key, or rotating one, relies on a one-time message valid for five minutes.
        </p>
        <p>When you read a paying address, nothing about that address is stored. The only records that change are your credit balance and your check count for the month.</p>
      </>
    ),
  },
  {
    id: "agents",
    title: "Agent verification",
    body: (
      <>
        <p>
          For an agent registered under ERC-8004, the service fetches its public registration file, the HTTPS endpoints it lists and its domain. It stores the outcome: whether the endpoints responded, whether the registration is valid, whether the domain is verified, a hash of the registration, and when the probe ran.
        </p>
        <p>Probe outcomes are also written to Robinhood Chain, where they are public to read.</p>
      </>
    ),
  },
  {
    id: "website",
    title: "The website",
    body: (
      <>
        <p>Cookies hold your wallet connection, so it survives a page reload. They serve no other purpose.</p>
        <p>
          A hosting provider serves the website, and your browser reaches Robinhood Chain through a public RPC endpoint. Each of them receives ordinary request data, your IP address among it, under its own privacy policy. Your keys and signatures are handled by your wallet app, under that app&apos;s policy.
        </p>
      </>
    ),
  },
  {
    id: "requests",
    title: "Request limits and logs",
    body: (
      <p>
        To enforce request rate limits, the Orrery API holds your IP address in memory only and never writes it to its database. The servers keep operational logs, for example indexer progress.
      </p>
    ),
  },
  {
    id: "use",
    title: "Why the data is held",
    body: (
      <p>
        Every record above exists to operate the service: issuing keys, granting credits and plans, applying the included checks and price tiers, answering readings, showing balances and earnings, maintaining the leaderboard and keeping the API reachable. Data is shared with the providers that run the service, such as hosting and Robinhood Chain access, and wherever the law requires it.
      </p>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        API keys are held as hashes. Key sign in and key rotation each rely on a one-time message your wallet signs. Your private keys and seed phrase never leave your wallet, and the service never needs them.
      </p>
    ),
  },
  {
    id: "choices",
    title: "Your choices",
    body: (
      <>
        <p>You decide which wallet to connect and which messages and transactions to sign, and you can disconnect the wallet from the website whenever you like.</p>
        <p>Records written to Robinhood Chain are public and remain on chain. To ask about anything the service holds for your address, use the contact details in the last section.</p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Revisions",
    body: <p>Whenever the service changes what it holds, this policy is revised. Each revision appears on this page with a fresh date at the top.</p>,
  },
  {
    id: "contact",
    title: "Contact",
    body: <Contact />,
  },
];

export default function Privacy() {
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="docs-main legal-main">
        <PageHead
          kicker="Legal"
          title="Privacy Policy"
          lead={<p>The records Orrery holds when you use orreryagent.com or the Orrery API, and the purpose of each one.</p>}
          art="signer-lookup"
        />
        <div className="legal">
          <aside className="legal-toc" aria-label="Contents">
            <p className="legal-updated">Updated {UPDATED}</p>
            <ol>
              {SECTIONS.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>
                    <span className="legal-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
            <p className="legal-other">
              <Link href="/terms">Terms of Use</Link>
            </p>
          </aside>
          <article className="docs-body legal-body">
            {SECTIONS.map((s, i) => (
              <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
                <h2 id={`${s.id}-h`}>
                  <span className="legal-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  {s.title}
                </h2>
                {s.body}
              </section>
            ))}
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}
