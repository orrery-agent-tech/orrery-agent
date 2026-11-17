import Link from "next/link";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageHead } from "@/components/PageHead";
import { OrryDocsLinks } from "@/components/orry/slots";

export const metadata = { title: "Orrery · Docs", description: "Developer guide to Orrery: give an agent a bounded signer, pay over x402, and take a signed reading of any paying address." };

export default function Docs() {
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="docs-main">
        <PageHead
          kicker="Docs"
          title="The Orrery developer guide."
          lead={<p>With Orrery, an agent&apos;s signer may spend from its operator&apos;s smart account, but only inside caps anyone can read. A merchant who is paid can read the paying address on chain for free, or buy a signed reading that also includes a fresh probe of the agent&apos;s endpoints.</p>}
          art="docs-manual"
        />
        <div className="docs-body">

        <h2>Add the SDK</h2>
        <pre>{`pnpm add @orrery-tech/sdk viem`}</pre>

        <h2>Operators: plot an agent&apos;s orbit</h2>
        <p>From your wallet, the <Link href="/dashboard/agents">Agents</Link> section of the dashboard handles every step. It deploys the account (a Safe running the Safe7579 adapter and the Orrery policy module), registers an ERC-8004 identity for the agent, generates the signer, opens a session with the caps you choose, and hands you the signer&apos;s key file for the agent.</p>
        <p>Prefer a script? The agent generates a new signer and signs its consent, then the operator submits the session from its own account. Each signer serves one session only.</p>
        <pre>{`import { signSessionConsent, operatorCalls, type Policy } from "@orrery-tech/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(generatePrivateKey()); // kept by the agent
const policy: Policy = {
  caps: [{ token: USDG, perTx: 10_000_000n, perDay: 50_000_000n, floatMax: 20_000_000n }],
  targets: [],
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  increaseDelay: 3600,
};
const consent = await signSessionConsent(signer, { chainId, module, account, agentId, policy });
const data = operatorCalls.openSession(agentId, signer.address, policy, consent);
// submit \`data\` to the module from your account (Safe execTransaction)`}</pre>

        <h2>Agents: pay over x402</h2>
        <p>Load the dashboard&apos;s key file into the agent&apos;s environment. Payments leave from the float, and ahead of each one the SDK refills the float through the module, never past the caps.</p>
        <pre>{`import { agentFromEnv } from "@orrery-tech/sdk";

const agent = agentFromEnv(); // loads ORRERY_SIGNER_KEY and the other key file values
const res = await agent.x402Fetch("https://api.example.com/data");`}</pre>

        <h2>Merchants: take a reading of the payer</h2>
        <p>A single wallet signature under <Link href="/dashboard/credits">Credits</Link> in the dashboard gives you an API key. One call then fetches the signed reading and verifies it against the chain.</p>
        <pre>{`import { checkPayment } from "@orrery-tech/sdk";

const v = await checkPayment(payer, process.env.ORRERY_API_KEY);
if (v.ok) {
  // v.result.caps, v.result.status, v.result.endpointsLive, v.result.validUntil
}`}</pre>
        <p>Or call it over plain HTTP from whatever language you use:</p>
        <pre>{`curl -H "authorization: Bearer $ORRERY_API_KEY" \\
  https://api.orreryagent.com/v1/check/by-signer/0xPAYING_ADDRESS`}</pre>

        <h2>Fields in a signed reading</h2>
        <table>
          <tbody>
            <tr><td>signer, account, agentId</td><td>The subject of the reading. What it states applies to payments sent by this signer.</td></tr>
            <tr><td>status</td><td>0 none · 1 active · 2 paused · 3 revoked · 4 expired.</td></tr>
            <tr><td>caps</td><td>For each token: the per payment cap, the daily cap, the float ceiling and today&apos;s spend.</td></tr>
            <tr><td>targetsHash</td><td>A hash over the allowed calls, which the JSON also lists in full.</td></tr>
            <tr><td>validFor</td><td>The first moment at which the module would let this signer&apos;s caps go up.</td></tr>
            <tr><td>accountKind, otherAccountModules</td><td>Whether the account is a recognised Safe, and whether anything else holds access to it.</td></tr>
            <tr><td>verified, endpointsLive, registrationValid, domainVerified</td><td>Verification status, plus the most recent probe of the agent&apos;s registration and endpoints.</td></tr>
            <tr><td>issuedAt, validUntil</td><td>When the reading was signed, and the time it stays valid until.</td></tr>
          </tbody>
        </table>
        <p>Scope: the caps count what this signer moves out of the account, in the listed tokens and in native ETH.</p>
        <OrryDocsLinks />
        </div>
      </main>
      <Footer />
    </div>
  );
}
