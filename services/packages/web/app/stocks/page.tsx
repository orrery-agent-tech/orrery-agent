import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { MarketsShell } from "@/components/markets/shell";
import { StocksView } from "@/components/markets/views";
import { FeatureGate } from "@/components/orry/gate";

export const metadata = { title: "Orrery · Stocks", description: "Stock tokens on Robinhood Chain, priced at the live market and traded for USDG in sealed batches." };

export default function StocksPage() {
  return (
    <MarketsShell>
      <FeatureGate
        feature="stocks"
        held={
        <>
          <OrryHead title="Equities, plotted on Robinhood Chain." lead={<p>Live market prices, what you hold, and a sealed order ticket for every listed stock.</p>} />
          <ComingSoon title="Stocks start soon." text="The list of stocks, their prices and a trade page for each one show here once Stocks starts." />
        </>
        }
      >
        <Suspense>
          <StocksView />
        </Suspense>
      </FeatureGate>
    </MarketsShell>
  );
}
