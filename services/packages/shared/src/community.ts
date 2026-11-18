import { parseAbi, type Address } from "viem";

/**
 * Lane L1 Community (`docs/updates/L1-COMMUNITY-SPEC.md`): the contracts' ABIs as the server and the web use them, the
 * API shapes and which release feature opens which route. The ABIs are checked against the Foundry artifacts by
 * `services/test/community-abi.unit.test.ts`.
 */

/** Burn sources L1 adds to `IOrryBurnEvents.Burned(source, amount)` (1 to 7 are taken; see `BURN_SOURCES`). */
export const COMMUNITY_BURN_SOURCES = { boost: 8, passes: 9, templateMarket: 10 } as const;

export const BOOST_KINDS = { post: 1, agent: 2, template: 3 } as const;
export const PASS_KINDS = { day: 1, week: 2 } as const;
export const ACCRUAL_KINDS = { cashback: 1, referral: 2 } as const;

/**
 * Event kinds of the Reward Pool and the Achievement Board (`kind` in `createEvent` and `create`). The contract stores
 * the number; these names are what the site and the indexer show. Missions measured by fees, locked value or time held
 * (R-34, R-41, R-43: no raffle).
 */
export const REWARD_KINDS: Record<number, string> = {
  1: "Most active in 7 days",
  2: "Bug bounty",
  3: "Stake",
  4: "Earn",
  5: "Agents",
  6: "Markets",
  7: "Burn",
  8: "Chat",
  9: "Weekly quest",
  10: "Seasonal",
  11: "Verify your agent",
};

export const rewardPoolAbi = parseAbi([
  "function orry() view returns (address)",
  "function admin() view returns (address)",
  "function achievements() view returns (address)",
  "function MAX_LOCK_BPS() view returns (uint16)",
  "function CHECK_WINDOW() view returns (uint64)",
  "function freeBalance(address asset) view returns (uint256)",
  "function lockedBalance(address asset) view returns (uint256)",
  "function lockCap(address asset) view returns (uint256)",
  "function eventCount() view returns (uint256)",
  "function prizeOf(uint256 id, address winner) view returns (uint256)",
  "function claimed(uint256 id, address winner) view returns (bool)",
  "function winnersOf(uint256 id) view returns (address[])",
  "function fund(address asset, uint256 amount) payable",
  "function sync(address asset) returns (uint256)",
  "function createEvent(address asset, uint256 amount, uint64 deadline, uint8 kind, bytes32 rulesHash) returns (uint256)",
  "function publishWinners(uint256 id, address[] winners, uint256[] amounts)",
  "function replaceWinners(uint256 id, address[] winners, uint256[] amounts)",
  "function claim(uint256 id) returns (uint256)",
  "function claimTo(uint256 id, address to) returns (uint256)",
  "function claimFor(uint256 id, address winner) returns (uint256)",
  "function expire(uint256 id)",
  "event Funded(address indexed asset, address indexed from, uint256 amount)",
  "event EventCreated(uint256 indexed id, address indexed asset, uint8 indexed kind, uint256 amount, uint64 deadline, bytes32 rulesHash)",
  "event WinnersPublished(uint256 indexed id, address[] winners, uint256[] amounts, uint256 returned, uint64 payableAt, bool replacement)",
  "event PrizePaid(uint256 indexed id, address indexed winner, address to, address indexed asset, uint256 amount)",
  "event EventExpired(uint256 indexed id, uint256 returned)",
  "event AchievementLocked(address indexed asset, uint256 amount)",
  "event AchievementReleased(address indexed asset, uint256 amount)",
  "event AchievementPaid(address indexed asset, address indexed to, uint256 amount)",
]);

export const orryAchievementsAbi = parseAbi([
  "function pool() view returns (address)",
  "function achievementCount() view returns (uint256)",
  "function claimed(uint256 id, address account) view returns (bool)",
  "function listedAt(uint256 id, address account) view returns (uint64)",
  "function create(address asset, uint256 rewardPerUser, uint32 maxRecipients, uint64 deadline, uint8 kind, address verifier, bytes32 rulesHash) returns (uint256)",
  "function claim(uint256 id, bytes data) returns (uint256)",
  "function publishCompleters(uint256 id, address[] accounts, uint64[] completedAt)",
  "function unlist(uint256 id, address account)",
  "function claimListed(uint256 id) returns (uint256)",
  "function claimListedFor(uint256 id, address account) returns (uint256)",
  "function close(uint256 id) returns (uint256)",
  "function subjectClaimedBy(uint256 id, bytes32 subject) view returns (address)",
  "event SubjectClaimed(uint256 indexed id, bytes32 indexed subject, address indexed account)",
  "error SubjectAlreadyClaimed(address by)",
  "event AchievementCreated(uint256 indexed id, address indexed asset, uint8 indexed kind, address verifier, uint256 rewardPerUser, uint32 maxRecipients, uint64 deadline, bytes32 rulesHash)",
  "event CompletersPublished(uint256 indexed id, address[] accounts, uint64[] completedAt, uint64 claimableAt)",
  "event CompleterUnlisted(uint256 indexed id, address indexed account)",
  "event AchievementClaimed(uint256 indexed id, address indexed account, uint64 completedAt, uint32 rank, address asset, uint256 amount)",
  "event AchievementClosed(uint256 indexed id, uint256 returned)",
]);

export const orryChatAbi = parseAbi([
  "function postFeeUsd() view returns (uint256)",
  "function maxTextBytes() view returns (uint256)",
  "function tipCutBps() view returns (uint16)",
  "function reportMinStake() view returns (uint256)",
  "function hideThreshold() view returns (uint32)",
  "function roomCount() view returns (uint256)",
  "function messageCount() view returns (uint256)",
  "function roomOf(uint256 room) view returns (bool exists, uint256 minStakeUsd)",
  "function postFee() view returns (uint256)",
  "function stakeUsdOf(address account) view returns (uint256)",
  "function authorOf(uint256 id) view returns (address)",
  "function reported(uint256 id, address reporter) view returns (bool)",
  "function createRoom(uint256 minStakeUsd, string name) returns (uint256)",
  "function post(uint256 room, uint256 replyTo, string text, uint256 maxFee) returns (uint256)",
  "function tip(uint256 id, uint256 amount)",
  "function report(uint256 id)",
  "event RoomCreated(uint256 indexed room, uint256 minStakeUsd, string name)",
  "event Posted(uint256 indexed id, uint256 indexed room, address indexed author, uint256 replyTo, uint256 fee, string text)",
  "event Tipped(uint256 indexed id, address indexed from, address indexed author, uint256 amount, uint256 cut)",
  "event Reported(uint256 indexed id, address indexed reporter, uint32 reports)",
  "event Hidden(uint256 indexed id, uint32 reports)",
]);

export const orryNamesAbi = parseAbi([
  "function nameFeeUsd() view returns (uint256)",
  "function nameOf(address account) view returns (string)",
  "function ownerOf(string name) view returns (address)",
  "function isValid(string name) pure returns (bool)",
  "function setName(string name, uint256 maxFee) returns (uint256)",
  "event NameSet(address indexed account, string name, bytes32 indexed key, uint256 fee)",
  "event NameReleased(address indexed account, bytes32 indexed key)",
]);

export const orryBoostAbi = parseAbi([
  "function usdPerDay(uint8 kind) view returns (uint256)",
  "function quote(uint8 kind, uint256 days_) view returns (uint256)",
  "function boostedUntil(uint8 kind, uint256 target) view returns (uint64)",
  "function boost(uint8 kind, uint256 target, uint256 days_, uint256 maxOrry) returns (uint64)",
  "event Boosted(uint8 indexed kind, uint256 indexed target, address indexed payer, uint256 days_, uint256 burned, uint64 until)",
]);

export const orryPassesAbi = parseAbi([
  "function dayPassUsd() view returns (uint256)",
  "function weekPassUsd() view returns (uint256)",
  "function quote(uint8 kind, uint256 count) view returns (uint256)",
  "function passUntil(address account) view returns (uint64)",
  "function buy(address account, uint8 kind, uint256 count, uint256 maxOrry) returns (uint64)",
  "event PassBought(address indexed account, address indexed payer, uint8 indexed kind, uint256 count, uint256 burned, uint64 until)",
]);

export const templateMarketAbi = parseAbi([
  "function burnBps() view returns (uint16)",
  "function minPriceUsd() view returns (uint256)",
  "function maxPriceUsd() view returns (uint256)",
  "function templateCount() view returns (uint256)",
  "function licensed(uint256 id, address buyer) view returns (bool)",
  "function quote(uint256 id) view returns (uint256)",
  "function list(uint256 priceUsd, bytes32 contentHash, string uri) returns (uint256)",
  "function setPrice(uint256 id, uint256 priceUsd)",
  "function setListed(uint256 id, bool listed)",
  "function buy(uint256 id, uint256 maxOrry) returns (uint256)",
  "event TemplateListed(uint256 indexed id, address indexed creator, uint256 priceUsd, bytes32 contentHash, string uri)",
  "event TemplatePriced(uint256 indexed id, uint256 priceUsd)",
  "event TemplateListing(uint256 indexed id, bool listed)",
  "event TemplateBought(uint256 indexed id, address indexed buyer, address indexed creator, uint256 paid, uint256 burned)",
]);

export const referralRegistryAbi = parseAbi([
  "function referrerOf(address referee) view returns (address)",
  "function linkedAt(address referee) view returns (uint64)",
  "function digestOf(address referee, address referrer, uint256 deadline) view returns (bytes32)",
  "function link(address referrer)",
  "function linkWithSig(address referee, address referrer, uint256 deadline, bytes signature)",
  "event Linked(address indexed referee, address indexed referrer, uint64 linkedAt)",
]);

export const cashbackRewardsAbi = parseAbi([
  "function publisher() view returns (address)",
  "function admin() view returns (address)",
  "function free() view returns (uint256)",
  "function totalReserved() view returns (uint256)",
  "function currentMonth() view returns (uint256)",
  "function openableAt(uint256 month) view returns (uint256)",
  "function owedUsd(address account, uint256 month) view returns (uint256)",
  "function claimedMonth(address account, uint256 month) view returns (bool)",
  "function referralUsd(address referrer, uint256 month) view returns (uint256)",
  "function claimable(address account, uint256 month) view returns (uint256)",
  "function seen(bytes32 key) view returns (bool)",
  "function accrue((address account, uint8 kind, address referee, uint64 feePaidAt, uint128 feeUsd, uint128 rewardUsd, bytes32 ref)[] records)",
  "function openPeriod(uint256 month) returns (uint256)",
  "function claim(uint256[] months) returns (uint256)",
  "function claimFor(address account, uint256[] months) returns (uint256)",
  "function closePeriod(uint256 month) returns (uint256)",
  "event Accrued(address indexed account, uint8 indexed kind, uint256 indexed month, address referee, uint256 feeUsd, uint256 rewardUsd, uint64 feePaidAt, bytes32 ref)",
  "event MonthVoided(address indexed account, uint256 indexed month, uint256 usd)",
  "event PeriodOpened(uint256 indexed month, uint256 totalUsd, uint256 orryNeeded, uint256 reserve)",
  "event RewardClaimed(address indexed account, uint256 indexed month, uint256 usd, uint256 orry)",
  "event PeriodClosed(uint256 indexed month, uint256 returned)",
]);

export const communityBurnedAbi = parseAbi(["event Burned(uint8 indexed source, uint256 amount)"]);

/** UTC calendar month index as `CashbackRewards` counts it: year * 12 + month - 1. */
export const monthIndex = (d: Date): number => d.getUTCFullYear() * 12 + d.getUTCMonth();
export const monthStart = (index: number): Date => new Date(Date.UTC(Math.floor(index / 12), index % 12, 1));
export const monthLabel = (index: number): string =>
  monthStart(index).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Which release feature opens which community route. A held feature's routes answer 404 like an unknown route. */
export const COMMUNITY_ROUTE_FEATURE = {
  "GET /v1/community/rooms": "chat",
  "GET /v1/community/messages": "chat",
  "GET /v1/community/names/:address": "chat",
  "GET /v1/community/rewards": "achievements",
  "GET /v1/community/achievements/:id/recipients": "achievements",
  "GET /v1/community/most-active": "achievements",
  "GET /v1/community/boosts": "burn-to-boost",
  "GET /v1/community/passes/:address": "passes",
  "GET /v1/community/templates": "template-market",
  "GET /v1/community/referrals/:address": "referrals",
  "GET /v1/community/referrals/leaderboard": "referrals",
  "GET /v1/community/cashback/:address": "cashback",
} as const;

// ------------------------------------------------------------------ API shapes (amounts are decimal strings)

export interface CommunityRoom {
  id: number;
  name: string;
  minStakeUsd: string; // USDG base units; "0" = open
}

export interface CommunityMessage {
  id: string;
  room: number;
  author: Address;
  authorName: string | null;
  replyTo: string | null;
  /** Null when stakers reported it enough times (R-32): the chain keeps it, this site does not show it. */
  text: string | null;
  hidden: boolean;
  fee: string;
  tips: string;
  reports: number;
  boostedUntil: string | null;
  time: string;
  txHash: string;
}

export interface CommunityRewardEvent {
  id: number;
  asset: Address;
  kind: number;
  kindName: string;
  amount: string;
  deadline: string;
  rulesHash: string;
  status: "open" | "published" | "expired";
  payableAt: string | null;
  winners: { address: string; amount: string; paid: boolean }[];
}

export interface CommunityAchievement {
  id: number;
  asset: Address;
  kind: number;
  kindName: string;
  onchain: boolean;
  verifier: Address | null;
  rewardPerUser: string;
  deadline: string;
  rulesHash: string;
  closed: boolean;
}

export interface CommunityRecipient {
  rank: number;
  address: string; // masked (R-5)
  completedAt: string;
  amount: string;
}

export interface MostActiveRow {
  rank: number;
  address: string; // masked
  feesUsd: string; // USDG base units
  bySource: Record<string, string>;
}

export interface MostActiveResponse {
  from: string;
  to: string;
  rules: string;
  rulesHash: string;
  rows: MostActiveRow[];
}

export interface CommunityTemplate {
  id: number;
  creator: Address;
  priceUsd: string;
  contentHash: string;
  uri: string;
  listed: boolean;
  sales: number;
  boostedUntil: string | null;
}

export interface ReferralSummary {
  referrer: Address | null;
  linkedAt: string | null;
  referees: number;
  /** Months with referral or cashback accruals for this address. */
  months: { month: number; label: string; owedUsd: string; openableAt: string; claimable: string; claimed: boolean }[];
  discountUntil: string | null; // the 90 day referee discount window (R-54), when linked
}
