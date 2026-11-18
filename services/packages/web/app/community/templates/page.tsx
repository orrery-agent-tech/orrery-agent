import { PageGuide } from "@/components/PageGuide";
import { TemplatesView } from "@/components/community/TemplatesView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { ORRY } from "@/lib/orry/config";

/** USDG-only mode (ORRY not configured): templates are priced and paid in USDG; no ORRY, burn or boost wording. */
const USDG_ONLY = !ORRY.token;

export const metadata = USDG_ONLY
  ? { title: "Orrery · Templates", description: "Ready-made agent policies, written by operators and sold for USDG." }
  : { title: "Orrery · Templates", description: "Ready-made agent policies, written by operators and bought with ORRY." };

export default function TemplatesPage() {
  return (
    <>
      <CommunityGate
        feature="template-market"
        held={
          <>
            <OrryHead
              title="Orbits other operators have plotted."
              lead={<p>{USDG_ONLY ? "Agent policy templates, priced and paid for in USDG." : "Agent policy templates with a USD price, paid for in ORRY."}</p>}
            />
            <ComingSoon title="The template market starts soon." text="Templates for sale, their prices and the form to list your own show here once the market starts." />
          </>
        }
      >
        <TemplatesView />
      </CommunityGate>
      <PageGuide
        audience={"Operators looking for a proven policy, and operators with one worth selling."}
        steps={
          USDG_ONLY
            ? [
                { title: "List", text: "Pick a USDG price, paste the policy JSON and point to where the file is hosted. The listing records the file's hash." },
                { title: "Buy", text: "Pay in USDG. Most of the price goes straight to the author, a share goes to Orrery, and your wallet keeps the licence." },
                { title: "Apply", text: "Compare the file with its recorded hash, then set it as your agent's policy." },
              ]
            : [
                { title: "List", text: "Pick a USD price, paste the policy JSON and point to where the file is hosted. The listing records the file's hash." },
                { title: "Buy", text: "Pay in ORRY. One part is burned, the remainder goes to the author, and your wallet keeps the licence." },
                { title: "Apply", text: "Compare the file with its recorded hash, then set it as your agent's policy." },
              ]
        }
      />
    </>
  );
}
