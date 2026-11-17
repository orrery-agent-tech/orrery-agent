/**
 * The published surface of the SDK (the npm package's "." entry). Only what the open "core" release needs: operator
 * setup, the agent client, the merchant check and Orrery's addresses on Robinhood Chain.
 *
 * Inside this workspace `@orrery/sdk` still resolves to `index.ts`, which also carries ORRY, markets, facilitator,
 * credit and launch helpers for features that are not released yet. Those are left out of the npm bundle on purpose;
 * add them later as subpath entries (for example `./orry`) in `tsup.config.ts` and `scripts/pack.mjs` when each one
 * opens.
 */
import type { Chain } from "viem";
import { robinhoodChain as robinhoodChainDefinition } from "@orrery/shared";

/** Robinhood Chain (4663), typed as a plain viem `Chain` so the published types stay portable. */
export const robinhoodChain: Chain = robinhoodChainDefinition;

export {
  // operator
  operatorCalls,
  signSessionConsent,
  policyHash,
  agentWalletDigest,
  type Policy,
  type TokenCap,
  type Target,
  // agent
  AgentClient,
  // merchant check
  OrreryApi,
  verifyCheck,
  parseCheck,
  readOnChain,
  type CheckResponse,
} from "./index";
export { agentFromEnv, checkPayment, ORRERY_MAINNET } from "./quick";
export {
  orreryPolicyModuleAbi,
  orreryAttestorAbi,
  orreryLensAbi,
  CHECK_VERSIONS,
  SessionStatus,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_RESPONSE,
  X402_VERSION,
  encodeHeader,
  decodeHeader,
  type CheckResult,
  type CheckResultV2,
  type CheckVersion,
  type TokenView,
  type PaymentRequired,
  type PaymentRequirements,
  type PaymentPayload,
  type Resource,
} from "@orrery/shared";
