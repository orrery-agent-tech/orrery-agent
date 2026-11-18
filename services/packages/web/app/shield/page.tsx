import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { FeatureGate } from "@/components/orry/gate";
import { R2Shell } from "@/components/r2/shell";
import { ShieldExits, ShieldPage as ShieldLive } from "@/components/r2/ShieldGate";

export const metadata = { title: "Orrery · Shield", description: "Hold USDG out of public view, and move it with a zero-knowledge proof." };

export default function ShieldPage() {
  return (
    <R2Shell>
      <FeatureGate
        feature="shield"
        held={
          <>
            <OrryHead title="USDG, held out of view." lead={<p>Move USDG into a private balance, pass it to another Shield account, and take it out to any address. Each step carries a zero-knowledge proof.</p>} />
            <ComingSoon title="Shield starts soon." text="Deposits, private transfers and withdrawals show here once Shield starts." />
            <ShieldExits />
          </>
        }
      >
        <ShieldLive />
      </FeatureGate>
    </R2Shell>
  );
}
