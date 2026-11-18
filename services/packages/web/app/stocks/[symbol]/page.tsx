import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { MarketsShell } from "@/components/markets/shell";
import { AssetView } from "@/components/markets/views";
import { FeatureGate } from "@/components/orry/gate";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const s = decodeURIComponent(symbol).toUpperCase();
  return { title: `Orrery · ${s}`, description: `Trade ${s} against USDG. Orders stay sealed until the batch clears at the live market price.` };
}

export default async function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const s = decodeURIComponent(symbol);
  return (
    <MarketsShell>
      <FeatureGate
        feature="stocks"
        held={
        <>
          <OrryHead title={s.toUpperCase()} />
          <ComingSoon title="Stocks start soon." text="This stock's price, your holding and its order ticket show here once Stocks starts." />
        </>
        }
      >
        <Suspense>
          <AssetView symbol={s} />
        </Suspense>
      </FeatureGate>
    </MarketsShell>
  );
}
