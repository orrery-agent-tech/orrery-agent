import { DocsShell } from "@/components/orry/docsShell";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon } from "@/components/orry/parts";
import { ORRY } from "@/lib/orry/config";

// Until ORRY exists the facilitator settles USDG only (USDG-only splitter factory, 2026-11-17); the ORRY sections return with it.
const withOrry = Boolean(ORRY.token);

export const metadata = {
  title: "Orrery · Guide for merchants",
  description: withOrry
    ? "The merchant payments guide: your payment address, x402 settlement in USDG or ORRY, forwarding, the fee and the directory."
    : "The merchant payments guide: your payment address, x402 settlement in USDG, forwarding and the fee.",
};

export default function MerchantsDocs() {
  return (
    <DocsShell kicker="Guide" title="Merchants" lead={<p>Charge agents for API calls, data or tools, and collect over x402 in {withOrry ? "USDG or ORRY" : "USDG"}.</p>}>
      <FeatureGate feature="facilitator" held={<ComingSoon title="The merchants guide arrives with merchant payments." text="This guide shows here once merchant payments start." />}>
        <>
          <h2>The address you are paid at</h2>
          <p>
            Orrery&apos;s splitter factory gives every merchant wallet exactly one payment address. Your wallet address determines it, so it can be
            computed before it is deployed, and the Merchants page displays it the moment you connect. Deploying it takes one transaction. Put it in
            the <code>payTo</code> of each x402 price you publish. The facilitator settles to factory payment addresses and nowhere else.
          </p>

          <h2>The path of a payment</h2>
          <p>
            For USDG, the payer signs an EIP-3009 authorization covering the exact amount to your payment address, and the facilitator submits it on
            chain.
            {withOrry ? (
              <>
                {" "}ORRY lacks EIP-3009, so ORRY payments use Permit2 instead: the payer grants Permit2 an approval once, then signs a message for each
                payment stating the amount and your payment address. Orrery&apos;s x402 proxy sends that ORRY to the address in the message and to no other.
              </>
            ) : null}
          </p>
          <p>
            Following the x402 facilitator API, your server calls <code>POST /v1/x402/verify</code> ahead of serving the request, then{" "}
            <code>POST /v1/x402/settle</code> to collect. <code>GET /v1/x402/supported</code> returns each asset with its transfer method.
          </p>

          <h2>Forwarding, and the fee</h2>
          <p>
            Funds sit at your payment address until a forward moves them on to your wallet. Orrery&apos;s keeper forwards by itself, and anyone, you
            included, may call <code>forward(token)</code> whenever they like. Each forward keeps 0.2% of the amount for Orrery.{" "}
            {withOrry ? "A USDG fee goes to the treasury, and an ORRY fee is burned and listed on the burn page." : "The USDG fee goes to the treasury."} Any other
            token forwards in full.
          </p>
          {withOrry ? (
            <p>
              Staking ORRY from your wallet brings the fee down, on the same stake tiers the markets use. The Merchants page displays your stake beside the
              fee it currently earns you.
            </p>
          ) : null}

          <h2>{withOrry ? "Your profile and the directory" : "Your profile"}</h2>
          <p>
            A merchant record holds a name, a link and a brief description. Saving it is a wallet signature, with no transaction sent.
            {withOrry
              ? " Once a merchant's stake reaches the badge level, the merchant is listed in the directory on the Merchants page, ordered by stake size."
              : null}
          </p>

          <h2>API</h2>
          <table>
            <tbody>
              <tr><td><code>GET /v1/merchants/:address</code></td><td>{withOrry ? "One merchant's payment address, setup state, fee discount, stake and volume over 30 days." : "One merchant's payment address, setup state, fee and volume over 30 days."}</td></tr>
              {withOrry ? <tr><td><code>GET /v1/merchants</code></td><td>The merchant directory.</td></tr> : null}
              <tr><td><code>GET /v1/x402/supported</code></td><td>Every asset, network and transfer method the facilitator takes.</td></tr>
              <tr><td><code>POST /v1/x402/verify</code></td><td>Confirms a payment ahead of serving the request.</td></tr>
              <tr><td><code>POST /v1/x402/settle</code></td><td>Submits the payment on chain and returns its transaction.</td></tr>
            </tbody>
          </table>
        </>
      </FeatureGate>
    </DocsShell>
  );
}
