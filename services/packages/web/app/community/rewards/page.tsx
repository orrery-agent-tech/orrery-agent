import { PageGuide } from "@/components/PageGuide";
import { RewardsView } from "@/components/community/RewardsView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";
import { ORRY } from "@/lib/orry/config";

/** USDG-only mode (ORRY not configured): achievements paid in USDG, no chat, name or tip wording. */
const USDG_ONLY = !ORRY.token;

export const metadata = USDG_ONLY
  ? { title: "Orrery · Rewards", description: "The Achievement Board: USDG rewards for wallets that complete each achievement, paid in order of completion." }
  : { title: "Orrery · Rewards", description: "The community Reward Pool, its events, the Achievement Board and this week's busiest wallets." };

export default function RewardsPage() {
  return (
    <>
      <CommunityGate
        feature="achievements"
        held={
          <>
            <OrryHead
              title="What the community pool pays out."
              lead={
                <p>
                  {USDG_ONLY
                    ? "The Reward Pool pays USDG rewards to wallets that complete each achievement."
                    : "Fees from chat and usernames, plus a cut of each tip, flow into the Reward Pool, and the pool funds every community reward."}
                </p>
              }
            />
            <ComingSoon title="Rewards start soon." text={USDG_ONLY ? "The pool balance and the Achievement Board show here once rewards start." : "Pool balances, its events and the Achievement Board show here once rewards start."} />
          </>
        }
      >
        <RewardsView />
      </CommunityGate>
      <PageGuide
        audience={"Orrery users who take part in its community."}
        steps={
          USDG_ONLY
            ? [
                { title: "Earn an achievement", text: "Every wallet that reaches one gets the same reward, paid in the order the wallets reach it." },
                { title: "Verify your agent", text: "Agent achievements read Orrery's verification of an ERC-8004 agent you own. Each agent earns its reward once." },
                { title: "Claim", text: "The pool pays USDG straight into your wallet." },
              ]
            : [
                { title: "Earn an achievement", text: "Every wallet that reaches one gets the same reward, paid in the order the wallets reach it." },
                { title: "Place in an event", text: "The winners list goes up first for anyone to check, and then each winner collects the prize." },
                { title: "Claim", text: "The pool pays straight into your wallet." },
              ]
        }
      />
    </>
  );
}
