import { Suspense } from "react";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { R2Shell } from "@/components/r2/shell";
import { LimitExits, LimitOrdersView } from "@/components/r2/LimitOrdersView";

export const metadata = { title: "Orrery · Limit orders", description: "Sign a limit order for a stock token, and it fills through that token's pool when the price arrives." };

export default function LimitOrdersPage() {
  return (
    <R2Shell>
      <FeatureGate
        feature="limit-orders"
        held={
          <>
            <OrryHead title="Set the price, then wait for it." lead={<p>Sign a buy or a sell for a stock token. It fills once the pool trades at your level.</p>} />
            <ComingSoon title="Limit orders start soon." text="Order entry and your standing orders show here once limit orders start." />
            <LimitExits />
          </>
        }
      >
        <Suspense>
          <LimitOrdersView />
        </Suspense>
      </FeatureGate>
    </R2Shell>
  );
}
