import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { ProvidersView } from "@/components/data/ProvidersView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { ORRY } from "@/lib/orry/config";

/** Before ORRY exists the registry lists any wallet with no stake, and providers are paid in USDG only (owner 2026-11-18). */
const USDG_ONLY = !ORRY.token;

export const metadata = {
  title: "Orrery · Data providers",
  description: USDG_ONLY
    ? "Put an x402 data endpoint on the list, and agents pay you in USDG for each call, settled by Orrery."
    : "Put an x402 data endpoint on the list with an ORRY stake, and agents pay you for each call, settled by Orrery.",
};

export default function DataProvidersPage() {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="app-main">
        <FeatureGate
          feature="data-providers"
          held={
            <>
              <OrryHead kicker="Data providers" title="Agents pay you for every call." lead={<p>{USDG_ONLY ? "List your x402 endpoint and get paid in USDG for every call." : "An ORRY stake puts your x402 endpoint on the list."}</p>} />
              <ComingSoon title="Provider listings start soon." text="All providers and your own listing show here once provider listings start." />
            </>
          }
        >
          <ProvidersView />
        </FeatureGate>
        <PageGuide
          audience={"Teams serving data that agents want, from an x402 endpoint they run."}
          steps={
            USDG_ONLY
              ? [
                  { title: "Register the endpoint", text: "One transaction from your wallet records the endpoint, the price per call and your payment address." },
                  { title: "Agents pay per call", text: "Agents pay your price in USDG to your payment address, settled through Orrery's data facilitator." },
                  { title: "Get paid", text: "Orrery retains 1% and sends the remainder to your wallet." },
                ]
              : [
                  { title: "Stake ORRY", text: "Your listing stays active while your stake is worth at least the listing minimum in USD." },
                  { title: "Register the endpoint", text: "A single transaction records the endpoint, the price per call and the payment address." },
                  { title: "Get paid", text: "Agents pay to your payment address. Orrery retains 1% and sends the remainder to your wallet." },
                ]
          }
        />
      </main>
      <Footer />
    </div>
  );
}
