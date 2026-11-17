import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageHead } from "@/components/PageHead";
import { X_HANDLE, X_URL } from "@/components/social";

export const metadata = {
  title: "Orrery · Terms of Use",
  description: "The rules for using orreryagent.com, the Orrery API and SDK and the Orrery contracts on Robinhood Chain.",
};

const UPDATED = "9 November 2026";

type Section = { id: string; title: string; body: ReactNode };

/** The contact line names only the channels that are configured; with none, it points to the site. */
function Contact() {
  const channels: ReactNode[] = [];
  if (X_URL) channels.push(<>on X at <a href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE}</a></>);
  return (
    <p>
      {channels.length ? <>Send questions about these terms to the team {channels[0]}{channels[1] ? <> or {channels[1]}</> : null}. </> : <>Send questions about these terms to the team through the contact channels published on orreryagent.com. </>}
      How your data is handled is set out in the <Link href="/privacy">Privacy Policy</Link>.
    </p>
  );
}

const SECTIONS: Section[] = [
  {
    id: "using",
    title: "Using Orrery",
    body: (
      <>
        <p>
          In these terms, the service means orreryagent.com, the Orrery API, the Orrery SDK and the Orrery contracts on Robinhood Chain. Using the service means you accept these terms.
        </p>
        <p>When you act for a company or other organisation, you accept these terms in its name and confirm you have the authority to do so.</p>
        <p>Complying with the laws that apply to you, wherever you use the service, is your responsibility.</p>
      </>
    ),
  },
  {
    id: "service",
    title: "What Orrery provides",
    body: (
      <>
        <p>
          Through the Orrery policy module, an operator sets the public bounds of each agent on the operator&apos;s own Safe account: a cap per payment, a cap per day, a float, the calls the agent may make, and a delay before any cap goes up. Agents hold ERC-8004 identities and pay in USDG over x402.
        </p>
        <p>A merchant takes a reading of a paying address and receives a reading signed under EIP-712. Readings draw on check credits, payable in USDG or ORRY, and agent verification is paid for the same way.</p>
        <p>ORRY is the protocol token, used across Earn pools, staking, claims and burns.</p>
        <p>Features become available in stages. Any feature still on its way carries a Coming soon label on the site.</p>
      </>
    ),
  },
  {
    id: "wallet",
    title: "Wallets and keys",
    body: (
      <>
        <p>Orrery runs with a wallet you hold. Your private keys and seed phrase remain there, and every message and transaction is signed by you.</p>
        <p>
          You pick each agent&apos;s caps and the signer allowed to use them. Every agent payment carries the signature of the agent signer you approved, and stays inside the caps recorded in the module on Robinhood Chain.
        </p>
        <p>Keep your keys, seed phrase and agent signer keys to yourself.</p>
      </>
    ),
  },
  {
    id: "api",
    title: "API keys and credits",
    body: (
      <>
        <p>A wallet address receives an API key when it signs in with a signed message or purchases check credits. An address holds a single active key at any time.</p>
        <p>Rotate your key whenever you want by signing a message from the same wallet, and the new key replaces the old one.</p>
        <p>Keep your API key to yourself. Readings made with it count against your address&apos;s included monthly checks and its credits.</p>
      </>
    ),
  },
  {
    id: "fees",
    title: "Fees",
    body: (
      <>
        <p>
          Before you pay, check pricing, credits and the platform plan are listed in the dashboard under <Link href="/dashboard/credits">Credits</Link>, and the agent verification fee under <Link href="/dashboard/agents">Agents</Link>. Earn pool fees and their split are published on the site and fixed in the contracts.
        </p>
        <p>Your transaction pays the fees in force at the moment it is made, and you cover the gas of every transaction your wallet sends.</p>
      </>
    ),
  },
  {
    id: "use",
    title: "Acceptable use",
    body: (
      <>
        <p>While using the service, you will:</p>
        <ul>
          <li>use it for lawful purposes only;</li>
          <li>register only the agents, endpoints and domains under your control, and describe each one honestly;</li>
          <li>keep to the API&apos;s published request rates;</li>
          <li>stay away from keys, accounts and systems that belong to someone else;</li>
          <li>leave the service working for everyone, and never try to disrupt it or probe it for weaknesses unless the team has given written permission;</li>
          <li>use the Orrery name and logo only in a way that leaves no doubt about who runs your product.</li>
        </ul>
      </>
    ),
  },
  {
    id: "onchain",
    title: "What the chain records",
    body: (
      <p>
        Robinhood Chain records sessions, caps, payments, agent verifications, Earn deposits, stakes, claims and burns. Every one of those records is public to read.
      </p>
    ),
  },
  {
    id: "others",
    title: "Third party services",
    body: <p>Orrery connects with services operated by others, such as your wallet and Robinhood Chain. Those services apply their own terms to your use of them.</p>,
  },
  {
    id: "brand",
    title: "Brand and content",
    body: <p>The Orrery team owns the Orrery name, logo, site design, artwork and text.</p>,
  },
  {
    id: "changes",
    title: "Revisions",
    body: (
      <p>
        As the service develops, these terms may be revised. Each revision appears on this page with a fresh date at the top, and continuing to use the service after a revision means you accept it.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: <Contact />,
  },
];

export default function Terms() {
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="docs-main legal-main">
        <PageHead
          kicker="Legal"
          title="Terms of Use"
          lead={<p>The rules that apply when you use orreryagent.com, the Orrery API and SDK and the Orrery contracts on Robinhood Chain.</p>}
          art="docs-manual"
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
              <Link href="/privacy">Privacy Policy</Link>
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
