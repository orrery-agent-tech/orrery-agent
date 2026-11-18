import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { MerchantsView } from "@/components/merchants/MerchantsView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { ORRY } from "@/lib/orry/config";

// Until ORRY exists the facilitator settles USDG only (USDG-only splitter factory, 2026-11-17); ORRY wording returns with it.
const withOrry = Boolean(ORRY.token);

export const metadata = { title: "Orrery · Merchants", description: `Take agent payments in ${withOrry ? "USDG or ORRY" : "USDG"} through Orrery's x402 facilitator, at a payment address that passes funds on to your wallet.` };

export default function MerchantsPage() {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="app-main">
          <FeatureGate
            feature="facilitator"
            held={
              <>
                <OrryHead kicker="Merchants" title={withOrry ? "Take agent payments in USDG or ORRY." : "Take agent payments in USDG."} lead={<p>Your API gets its own payment address, and Orrery&apos;s x402 facilitator settles every call to it.</p>} />
                <ComingSoon title="Merchant payments start soon." text={`Your payment address${withOrry ? ", its balances and the merchant directory show" : " and its balances show"} here once merchant payments start.`} />
              </>
            }
          >
            <MerchantsView />
          </FeatureGate>
          <PageGuide
            audience={"Teams selling API calls, data or tools to AI agents."}
            steps={[
              { title: "Create your payment address", text: "A single transaction from your wallet. That address becomes the payTo of each price you publish." },
              { title: "Post your x402 prices", text: withOrry ? "Aim your x402 middleware at Orrery's facilitator. Agents then pay in USDG, or in ORRY through Permit2." : "Aim your x402 middleware at Orrery's facilitator. Agents then pay in USDG." },
              { title: "Receive", text: withOrry ? "Each payment passes on to your wallet, less Orrery's fee. Staking ORRY brings that fee down and adds you to the directory." : "Each payment passes on to your wallet, less Orrery's fee." },
            ]}
          />
      </main>
      <Footer />
    </div>
  );
}
