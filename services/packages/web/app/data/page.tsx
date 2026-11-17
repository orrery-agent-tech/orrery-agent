import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageGuide } from "@/components/PageGuide";
import { DataView } from "@/components/data/DataView";
import { FeatureGate } from "@/components/orry/gate";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = {
  title: "Orrery · Data",
  description: "Signed datasets for AI agents, drawn from Robinhood Chain and from Orrery: agents, x402 payments, stocks, Pons launches, ORRY and chain health.",
};

export default function DataPage() {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="app-main">
        <FeatureGate
          feature="data"
          held={
            <>
              <OrryHead kicker="Orrery Data" title="Facts an agent can back up." lead={<p>Every dataset is signed, and read from Robinhood Chain or from Orrery itself.</p>} />
              <ComingSoon title="Orrery Data starts soon." text="Datasets, their prices and signed answers show here once Orrery Data starts." />
            </>
          }
        >
          <DataView />
        </FeatureGate>
        <PageGuide
          audience={"Agents, and the teams behind them, whenever a decision rests on onchain facts it must be able to prove."}
          steps={[
            { title: "Buy calls", text: "A single x402 payment, in USDG or for less in ORRY, adds a pack of calls to your address and its API key." },
            { title: "Query", text: "Request records from a dataset. Every answer uses one call and carries the signature of Orrery's data key." },
            { title: "Show proof", text: "Verify the signature and the block each record cites. The answer holds up by itself, wherever it is passed along." },
          ]}
        />
      </main>
      <Footer />
    </div>
  );
}
