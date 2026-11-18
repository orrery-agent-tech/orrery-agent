import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { R2Shell } from "@/components/r2/shell";
import { PredictExits, PredictView } from "@/components/r2/PredictView";

export const metadata = { title: "Orrery · Predict", description: "Put USDG on where a stock or ETH price will close. The first market price after the close settles it." };

export default function PredictPage() {
  return (
    <R2Shell>
      <FeatureGate
        feature="predict"
        held={
          <>
            <OrryHead title="Take a view on the close." lead={<p>Take YES or NO on a stock or ETH price at a fixed time. The market price at the close decides the outcome.</p>} />
            <ComingSoon title="Predict starts soon." text="Markets, their pools and your own positions show here once Predict starts." />
            <PredictExits />
          </>
        }
      >
        <Suspense>
          <PredictView />
        </Suspense>
      </FeatureGate>
    </R2Shell>
  );
}
