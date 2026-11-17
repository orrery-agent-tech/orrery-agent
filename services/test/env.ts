/**
 * Ports of the test stack. Defaults are the v1 ones (anvil :8546, Postgres :55432); a session that shares the machine
 * with another test run sets ORRERY_TEST_ANVIL_PORT, ORRERY_TEST_PG_PORT and ORRERY_TEST_PG_NAME to its own.
 */
export const ANVIL_PORT = Number(process.env.ORRERY_TEST_ANVIL_PORT ?? 8546);
export const PG_PORT = Number(process.env.ORRERY_TEST_PG_PORT ?? 55432);
export const PG_NAME = process.env.ORRERY_TEST_PG_NAME ?? "orrery-pg-test";
export const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
export const DATABASE_URL = `postgres://orrery:orrery@127.0.0.1:${PG_PORT}/orrery`;
/** The real-contract ORRY suite starts its own anvil (it moves chain time by days) on this port. */
export const ORRY_ANVIL_PORT = Number(process.env.ORRERY_TEST_ORRY_ANVIL_PORT ?? ANVIL_PORT + 1);
/** The markets suite moves chain time too, on its own anvil. */
export const MARKETS_ANVIL_PORT = Number(process.env.ORRERY_TEST_MARKETS_ANVIL_PORT ?? ANVIL_PORT + 2);
/** The facilitator suite deploys the real splitter contracts and Permit2 on its own anvil. */
export const FACILITATOR_ANVIL_PORT = Number(process.env.ORRERY_TEST_FACILITATOR_ANVIL_PORT ?? ANVIL_PORT + 3);
/** Lane L1: the community suite deploys the L1 contracts and moves chain time by months on its own anvil. */
export const COMMUNITY_ANVIL_PORT = Number(process.env.ORRERY_TEST_COMMUNITY_ANVIL_PORT ?? ANVIL_PORT + 4);
/** Lane L2: the data suite deploys the data contracts, Permit2 and the splitters on its own anvil. */
export const DATA_ANVIL_PORT = Number(process.env.ORRERY_TEST_DATA_ANVIL_PORT ?? ANVIL_PORT + 6);
/** Lane L2: the MCP suite runs the API with Orrery Data on its own anvil. */
export const MCP_ANVIL_PORT = Number(process.env.ORRERY_TEST_MCP_ANVIL_PORT ?? ANVIL_PORT + 7);
/** Lane L3 (R2 markets, paymaster) deploys its real contracts on its own anvil. */
export const R2_ANVIL_PORT = Number(process.env.ORRERY_TEST_R2_ANVIL_PORT ?? ANVIL_PORT + 5);
/** Lane L4: the attester and Credit suite deploys its contracts and moves chain time on its own anvil. */
export const CREDIT_ANVIL_PORT = Number(process.env.ORRERY_TEST_CREDIT_ANVIL_PORT ?? ANVIL_PORT + 8);
/** Lane L5 (Agent Launch) deploys its real contracts on its own anvil. */
export const LAUNCH_ANVIL_PORT = Number(process.env.ORRERY_TEST_LAUNCH_ANVIL_PORT ?? ANVIL_PORT + 9);
