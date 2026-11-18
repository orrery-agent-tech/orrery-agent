import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import {
  MarketsApi,
  OrryApi,
  aggregatorV3Abi,
  erc20MetaAbi,
  iFeeTiersAbi,
  iMarketFactoryAbi,
  iOrryPriceOracleAbi,
  iSealedBatchMarketAbi,
  maskAddress,
  marketCalls,
  newSalt,
  orderCommitment,
  type MarketOrder,
} from "@orrery/sdk";
import { MarketKeeper, MarketRelay, buildApi, connect, indexMarketsOnce, loadConfig, makeChain, migrate, roundHintFor, setRelease, type Config, type Sql } from "@orrery/server";
import { commitmentProbeAbi, commitmentProbeBytecode, orryStandInAbi, orryStandInBytecode } from "./generated/standins.js";
import { DATABASE_URL, MARKETS_ANVIL_PORT } from "./env.js";
import { ROLE, anvilKey, clients, mine, startAnvil, warp } from "./orry-system.js";

/**
 * Wave R1 market services against stand-ins of the frozen ABIs (`markets-abi.ts`; lane M-1's contracts are not merged):
 * every event is emitted with the exact topics and data of the frozen interface, every view answers ABI-encoded values.
 * Own anvil (batches follow chain time), the shared test Postgres.
 */

const RPC = `http://127.0.0.1:${MARKETS_ANVIL_PORT}`;
const M = iSealedBatchMarketAbi as Abi;
const MARKET_EVENTS = iSealedBatchMarketAbi as Abi; // includes Burned (ISealedBatchMarket extends IOrryBurnEvents)
const POOL_ID: Hex = "0x674e43f4240ded5517b1da819f50738e01f8d73d60d5f22378c33a8e360ab985";
const E18 = 10n ** 18n;
const PERIOD = 300n;
const REVEAL = 60n;
const EXPIRY = 86_400n;
const MAX_STALENESS = 90 * 3600;
const PHASE = 3n << 64n;

let anvil: ChildProcess | undefined;
let c: ReturnType<typeof clients>;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let baseUrl: string;
let api: MarketsApi;
let factory: Address, market: Address, feed: Address, asset: Address, usdg: Address, orryStandIn: Address, feeTiers: Address, oracle: Address;
let end0: bigint;
const A = () => c.address(ROLE.alice);
const B = () => c.address(ROLE.bob);
const C = () => c.address(ROLE.carol);

async function deploy(abi: Abi, bytecode: Hex): Promise<Address> {
  const w = c.wallet(ROLE.deployer);
  const hash = await w.deployContract({ abi, bytecode, chain: foundry, account: w.account });
  return (await c.pub.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function call(to: Address, fn: string, args: unknown[]) {
  const w = c.wallet(ROLE.deployer);
  const hash = await w.writeContract({ address: to, abi: orryStandInAbi, functionName: fn as never, args: args as never, chain: foundry, account: w.account });
  const r = await c.pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return r;
}
const answer = (to: Address, abi: Abi, fn: string, result: unknown) =>
  call(to, "setResponse", [toFunctionSelector(getAbiItem({ abi, name: fn }) as never), encodeFunctionResult({ abi, functionName: fn, result } as never)]);
const answerFor = (to: Address, abi: Abi, fn: string, args: unknown[], result: unknown) =>
  call(to, "setResponseFor", [encodeFunctionData({ abi, functionName: fn, args } as never), encodeFunctionResult({ abi, functionName: fn, result } as never)]);
const revertWith = (to: Address, abi: Abi, fn: string, error: string, on = true) =>
  call(to, "setRevert", [toFunctionSelector(getAbiItem({ abi, name: fn }) as never), encodeErrorResult({ abi, errorName: error } as never), on]);
async function emit(from: Address, abi: Abi, event: string, args: Record<string, unknown>) {
  const item = getAbiItem({ abi, name: event }) as unknown as { inputs: { name: string; type: string; indexed?: boolean; components?: unknown }[] };
  const topics = encodeEventTopics({ abi, eventName: event, args } as never) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never);
  return call(from, "emitLog", [topics, data]);
}
const now = async () => (await c.pub.getBlock()).timestamp;
async function catchUp() {
  await mine({ pub: c.pub }, cfg.confirmations + 1);
  let r;
  do r = await indexMarketsOnce(cfg, makeChain(cfg), sql, { range: 40n });
  while (r.lag > BigInt(cfg.confirmations));
}
const round = (id: bigint, answer: bigint, updatedAt: bigint) => [id, answer, updatedAt, updatedAt, id] as const;
const emptyResult = { cleared: false, price: 0n, roundId: 0n, assetFilled: 0n, usdgFilled: 0n, usdgFees: 0n, orryFeesBurned: 0n, ordersDropped: 0, assetViaPool: 0n, usdgViaPool: 0n };

function env(extra: Record<string, string> = {}) {
  return {
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: orryStandIn,
    ORRERY_ATTESTOR: orryStandIn,
    ORRERY_LENS: orryStandIn,
    ORRERY_REGISTRY: orryStandIn,
    ORRERY_USDG: usdg,
    ORRERY_TREASURY: orryStandIn,
    ORRERY_CONFIRMATIONS: "2",
    ORRERY_ORRY_TOKEN: orryStandIn,
    ORRERY_ORRY_HOOK: orryStandIn,
    ORRERY_ORRY_EARN_FACTORY: orryStandIn,
    ORRERY_ORRY_STAKING: orryStandIn,
    ORRERY_ORRY_ROUTER: orryStandIn,
    ORRERY_ORRY_BUYBACK: orryStandIn,
    ORRERY_ORRY_LENS: orryStandIn,
    ORRERY_POOL_MANAGER: orryStandIn,
    ORRERY_ORRY_FEATURES: "burn,stocks,swap,darkpool",
    ORRERY_MARKET_FACTORY: factory,
    ORRERY_MARKETS_CACHE_MS: "0",
    ORRERY_ORRY_CACHE_MS: "0",
    ORRERY_RELEASES_CACHE_MS: "0",
    ORRERY_PUBLIC_RATE_PER_MINUTE: "600",
    ...extra,
  };
}

beforeAll(async () => {
  anvil = await startAnvil(MARKETS_ANVIL_PORT);
  c = clients(RPC);
  const startBlock = await c.pub.getBlockNumber();
  const ins: Address[] = [];
  for (let i = 0; i < 8; i++) ins.push(await deploy(orryStandInAbi as Abi, orryStandInBytecode));
  [factory, market, feed, asset, usdg, orryStandIn, feeTiers, oracle] = ins as [Address, Address, Address, Address, Address, Address, Address, Address];

  // batch 0's reveal window ends 100 s from now: the commit window of batch 0 is open
  end0 = (await now()) + 100n;
  await answer(market, M, "priceFeed", feed);
  await answer(market, M, "usdg", usdg);
  await answerFor(market, M, "revealEnd", [0n], end0);
  await answerFor(market, M, "revealEnd", [1n], end0 + PERIOD);
  await answer(market, M, "commitSeconds", Number(PERIOD - REVEAL));
  await answer(market, M, "revealSeconds", Number(REVEAL));
  await answer(market, M, "feeBps", 15);
  await answer(market, M, "minNotionalUsdg", 10_000_000n);
  await answer(market, M, "commitFeeUsd", 50_000n);
  await answer(market, M, "maxStaleness", MAX_STALENESS);
  await answer(market, M, "MAX_ORDERS", 64);
  await answer(market, M, "EXPIRY", EXPIRY);
  await answer(market, M, "orderCount", 0n);
  await answer(market, M, "result", emptyResult);
  await answer(market, M, "maxDeviationBps", 50);
  await answer(market, M, "orryFeeDiscountBps", 2500);
  await answer(market, M, "feeTiers", feeTiers);
  await answer(feeTiers, iFeeTiersAbi as Abi, "orryPrice", oracle);
  await answer(feeTiers, iFeeTiersAbi as Abi, "tierCount", 2n);
  await answerFor(feeTiers, iFeeTiersAbi as Abi, "tier", [0n], [1_000_000_000n, 2500]);
  await answerFor(feeTiers, iFeeTiersAbi as Abi, "tier", [1n], [10_000_000_000n, 5000]);
  await answer(feeTiers, iFeeTiersAbi as Abi, "stakeUsd", 0n);
  await answer(feeTiers, iFeeTiersAbi as Abi, "discountBps", 0);
  await answer(oracle, iOrryPriceOracleAbi as Abi, "ready", true);
  await answer(market, M, "remainderPool", [{ currency0: asset, currency1: usdg, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" }, true]);
  await answer(asset, erc20MetaAbi as Abi, "symbol", "ACME");
  await answer(asset, erc20MetaAbi as Abi, "name", "Acme Corp");
  await answer(asset, erc20MetaAbi as Abi, "decimals", 18);
  await answer(feed, aggregatorV3Abi as Abi, "decimals", 8);
  await answer(feed, aggregatorV3Abi as Abi, "latestRoundData", round(PHASE | 10n, 25_000_000_000n, end0 - 3600n));
  await answer(factory, iMarketFactoryAbi as Abi, "marketCount", 1n);
  await answerFor(factory, iMarketFactoryAbi as Abi, "marketAt", [0n], market);

  cfg = loadConfig({ ...env(), ORRERY_MARKETS_START_BLOCK: startBlock.toString(), ORRERY_ORRY_START_BLOCK: startBlock.toString() });
  sql = connect(cfg.databaseUrl);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrate(sql);
  app = buildApi(cfg, makeChain(cfg), sql);
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  api = new MarketsApi(baseUrl);
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
  anvil?.kill("SIGTERM");
});

const order = (o: Partial<MarketOrder>): MarketOrder => ({ sellAsset: false, amountIn: 1_000_000_000n, limitPrice: 260_000_000n, mode: "limit", payFeeInOrry: false, ...o });
const abiOrder = (o: MarketOrder) => ({ ...o, mode: o.mode === "swap" ? 1 : 0 });

describe("SDK order commitment", () => {
  it("matches Solidity's abi.encode of the frozen Order layout", async () => {
    const probe = await deploy(commitmentProbeAbi as Abi, commitmentProbeBytecode);
    for (const o of [order({}), order({ sellAsset: true, mode: "swap", payFeeInOrry: true, amountIn: 3n * E18 })]) {
      const salt = newSalt();
      const onChain = await c.pub.readContract({ address: probe, abi: iSealedBatchMarketAbi, functionName: "commitmentFor", args: [7n, A(), abiOrder(o), salt] });
      expect(orderCommitment(7n, A(), o, salt)).toBe(onChain);
    }
    expect(marketCalls.reveal(order({}), newSalt()).slice(0, 10)).toBe(toFunctionSelector(getAbiItem({ abi: M, name: "reveal" }) as never));
  });
});

describe("markets indexer and routes", () => {
  const salts = { a: newSalt(), b: newSalt(), c: newSalt() };
  const oA = order({});
  const oB = order({ sellAsset: true, amountIn: 2n * E18, limitPrice: 240_000_000n, mode: "swap", payFeeInOrry: true });

  it("indexes the factory's market with its constructor values, and lists it with its feed price", async () => {
    await emit(factory, iMarketFactoryAbi as Abi, "MarketCreated", { asset, market, priceFeed: feed, remainderPoolId: POOL_ID });
    await catchUp();
    const r = await api.markets();
    expect(r.markets).toHaveLength(1);
    const m = r.markets[0]!;
    expect(m).toMatchObject({
      market: getAddress(market),
      asset: { address: getAddress(asset), symbol: "ACME", name: "Acme Corp", decimals: 18 },
      usdg: getAddress(usdg),
      price: { feed: getAddress(feed), answer: "25000000000", decimals: 8, roundId: (PHASE | 10n).toString(), updatedAt: Number(end0 - 3600n), fresh: true },
      params: { commitSeconds: 240, revealSeconds: 60, feeBps: 15, minNotionalUsdg: "10000000", commitFeeUsd: "50000", maxStaleness: MAX_STALENESS, maxOrders: 64, expirySeconds: 86400, maxDeviationBps: 50, orryFeeDiscountBps: 2500 },
      phase: { batch: "0", inCommit: true, endsAt: Number(end0 - REVEAL) },
      remainderPool: { poolId: POOL_ID, listed: true },
      feeTiers: getAddress(feeTiers),
    });
    expect(r.chainTime).toBe(Number(await now()));
    expect((await api.market(market)).asset.symbol).toBe("ACME");
    expect((await fetch(`${baseUrl}/v1/markets/${asset}`)).status).toBe(404);
  });

  it("commits, the commit fee burn (5), reveals; orders stay hidden until the reveal window ends", async () => {
    await emit(market, MARKET_EVENTS, "Committed", { batch: 0n, account: A(), commitment: orderCommitment(0n, A(), oA, salts.a), orryBurned: 90n * E18 });
    await emit(market, MARKET_EVENTS, "Burned", { source: 5, amount: 90n * E18 });
    await emit(market, MARKET_EVENTS, "Committed", { batch: 0n, account: B(), commitment: orderCommitment(0n, B(), oB, salts.b), orryBurned: 90n * E18 });
    await emit(market, MARKET_EVENTS, "Burned", { source: 5, amount: 90n * E18 });
    await emit(market, MARKET_EVENTS, "Committed", { batch: 0n, account: C(), commitment: orderCommitment(0n, C(), order({}), salts.c), orryBurned: 0n });
    await catchUp();
    let h = await api.walletOrders(A());
    expect(h.orders).toHaveLength(1);
    expect(h.orders[0]).toMatchObject({ batch: "0", status: "committed", symbol: "ACME", commitFeeBurned: (90n * E18).toString(), order: null, revealEndsAt: Number(end0) });

    await warp({ pub: c.pub }, end0 - REVEAL - (await now()) + 1n); // reveal window
    await emit(market, MARKET_EVENTS, "Revealed", { batch: 0n, account: A(), order: abiOrder(oA) });
    await emit(market, MARKET_EVENTS, "Revealed", { batch: 0n, account: B(), order: abiOrder(oB) });
    await catchUp();
    const during = await api.batch(market, 0n);
    expect(during).toMatchObject({ status: "reveal", commits: 3, reveals: 2, commitFeesBurned: (180n * E18).toString(), orders: null, result: null });
    expect(during).toMatchObject({ commitEndsAt: Number(end0 - REVEAL), revealEndsAt: Number(end0), expiresAt: Number(end0 + EXPIRY) });

    await warp({ pub: c.pub }, end0 - (await now()) + 1n); // reveal window over, not cleared
    await catchUp();
    const after = await api.batch(market, 0n);
    expect(after.status).toBe("clearing");
    expect(after.orders).toEqual(
      [
        { account: maskAddress(A()), ...oA, amountIn: oA.amountIn.toString(), limitPrice: oA.limitPrice.toString(), status: "revealed", fill: null },
        { account: maskAddress(B()), ...oB, amountIn: oB.amountIn.toString(), limitPrice: oB.limitPrice.toString(), status: "revealed", fill: null },
      ].sort((x, y) => (x.account < y.account ? -1 : 1)),
    );
    const text = JSON.stringify(after).toLowerCase();
    for (const who of [A(), B(), C()]) expect(text).not.toContain(who.toLowerCase().slice(2));
    h = await api.walletOrders(C());
    expect(h.orders[0]).toMatchObject({ status: "missed", order: null });
  });

  it("clearing: filled, dropped, the ORRY fee burn (6), results and per-wallet history", async () => {
    // the pool leg (R1b) is only in result(batch); the indexer reads it at the clearing block
    await answerFor(market, M, "result", [0n], { ...emptyResult, cleared: true, assetViaPool: E18, usdgViaPool: 250_000_000n });
    const clearTx = await emit(market, MARKET_EVENTS, "OrderFilled", { batch: 0n, account: A(), inputUsed: 1_000_000_000n, output: 4n * E18, usdgFee: 1_500_000n, orryFee: 0n });
    await emit(market, MARKET_EVENTS, "OrderDropped", { batch: 0n, account: B() });
    await emit(market, MARKET_EVENTS, "Burned", { source: 6, amount: 7n * E18 });
    const cleared = await emit(market, MARKET_EVENTS, "BatchCleared", { batch: 0n, price: 250_000_000n, roundId: PHASE | 10n, assetFilled: 4n * E18, usdgFilled: 1_000_000_000n });
    await catchUp();
    const b = await api.batch(market, 0n);
    expect(b.status).toBe("cleared");
    expect(b.result).toMatchObject({
      price: "250000000", roundId: (PHASE | 10n).toString(), assetFilled: (4n * E18).toString(), usdgFilled: "1000000000", assetViaPool: E18.toString(), usdgViaPool: "250000000",
      usdgFees: "1500000", orryFeesBurned: "0", ordersFilled: 1, ordersDropped: 1, ordersUnfilled: 0, tx: cleared.transactionHash, block: Number(cleared.blockNumber),
    });
    const byAccount = Object.fromEntries(b.orders!.map((o) => [o.account, o]));
    expect(byAccount[maskAddress(A())]).toMatchObject({ status: "filled", fill: { inputUsed: "1000000000", output: (4n * E18).toString(), usdgFee: "1500000", orryFee: "0", tx: clearTx.transactionHash } });
    expect(byAccount[maskAddress(B())]).toMatchObject({ status: "dropped", fill: null });

    expect((await api.walletOrders(A())).orders[0]).toMatchObject({ status: "filled", order: { mode: "limit", sellAsset: false } });
    expect((await api.walletOrders(B())).orders[0]).toMatchObject({ status: "dropped", order: { mode: "swap", sellAsset: true, payFeeInOrry: true } });
    expect((await api.walletOrders(C())).orders[0]!.status).toBe("missed");
    const list = await api.batches(market, { limit: 10 });
    expect(list.batches.map((x) => [x.batch, x.status, x.orders])).toEqual([["0", "cleared", null]]);
    expect((await api.batches(market, { before: 0n })).batches).toEqual([]);

    // burns: sources 5 and 6 from the market join the ORRY burn list
    const burns = await new OrryApi(baseUrl).burns(10);
    expect(burns.bySource).toEqual({ "1": "0", "2": "0", "3": "0", "4": "0", "5": (180n * E18).toString(), "6": (7n * E18).toString(), "7": "0" });
    expect(burns.items.map((i) => i.source)).toEqual([6, 5, 5]);
    expect(burns.total).toBe((187n * E18).toString());
  });

  it("a market the factory never created is not indexed, its burns are not counted", async () => {
    const stray = await deploy(orryStandInAbi as Abi, orryStandInBytecode);
    await emit(stray, MARKET_EVENTS, "Burned", { source: 5, amount: 999n });
    await emit(factory, iMarketFactoryAbi as Abi, "OwnershipTransferStarted", { previousOwner: A(), newOwner: B() });
    await catchUp();
    expect((await new OrryApi(baseUrl).burns(10)).bySource["5"]).toBe((180n * E18).toString());
    expect((await api.markets()).markets).toHaveLength(1);
    // the burn list's own rule, whatever reaches market_events: only markets the factory created count
    await sql`insert into market_events (block_number, log_index, tx_hash, address, event, args, block_time)
      values (1, 999, ${"0x" + "ab".repeat(32)}, ${stray.toLowerCase()}, 'Burned', ${sql.json({ source: 5, amount: "999" })}, now())`;
    expect((await new OrryApi(baseUrl).burns(10)).bySource["5"]).toBe((180n * E18).toString());
    await sql`delete from market_events where log_index = 999 and block_number = 1`;
  });

  it("a re-index from the start changes no derived row", async () => {
    const snap = async () => ({
      batches: await sql`select * from market_batches order by market, batch`,
      orders: await sql`select * from market_orders order by market, batch, account`,
      markets: await sql`select * from markets order by market`,
    });
    const before = await snap();
    await sql`update indexer_state set last_block = ${(cfg.markets!.startBlock - 1n).toString()} where id = 'markets'`;
    await catchUp();
    expect(await snap()).toEqual(before);
  });

  it("fee tiers: thresholds in USD from the FeeTiers contract, an account's stake in USD, inactive while the oracle is not ready", async () => {
    const table = { address: getAddress(feeTiers), orryPrice: getAddress(oracle), tiers: [{ minStakeUsd: "1000000000", discountBps: 2500 }, { minStakeUsd: "10000000000", discountBps: 5000 }] };
    expect(await api.feeTiers()).toMatchObject({ usdDecimals: 6, tables: [{ ...table, active: true, account: null }] });
    await answerFor(feeTiers, iFeeTiersAbi as Abi, "stakeUsd", [A()], 1_500_000_000n);
    await answerFor(feeTiers, iFeeTiersAbi as Abi, "discountBps", [A()], 2500);
    expect((await api.feeTiers(A())).tables).toEqual([{ ...table, active: true, account: { address: A(), stakeUsd: "1500000000", discountBps: 2500 } }]);
    await answer(oracle, iOrryPriceOracleAbi as Abi, "ready", false);
    expect((await api.feeTiers()).tables[0]!.active).toBe(false);
    await answer(oracle, iOrryPriceOracleAbi as Abi, "ready", true);
    expect((await fetch(`${baseUrl}/v1/markets/fee-tiers?account=0x12`)).status).toBe(400);
  });

  it("bad input answers 400; malformed paths 404", async () => {
    expect((await fetch(`${baseUrl}/v1/markets/${market}/batches?limit=0`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/v1/markets/${market}/batches?before=x`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/v1/markets/${market}/batches/-1`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/v1/markets/accounts/0x1234/orders`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/v1/markets/0x1234`)).status).toBe(404);
  });
});

describe("reveal relay", () => {
  const relayKey = anvilKey(13);
  const relayer = () => c.address(13);
  /** Moves to the start of a batch's commit window, so the whole commit window lies ahead. */
  async function freshBatch(): Promise<bigint> {
    const t = await now();
    const n = t < end0 ? 0n : (t - end0) / PERIOD + 1n;
    await warp({ pub: c.pub }, end0 + n * PERIOD - (await now()) + 1n); // revealEnd(n) passed: batch n + 1's commit window opens
    return n + 1n;
  }

  it("queues an order that matches the account's commitment, never echoes the salt, and refuses the rest", async () => {
    await (c.wallet(ROLE.deployer)).sendTransaction({ to: relayer(), value: E18, chain: foundry, account: c.wallet(ROLE.deployer).account }).then((h) => c.pub.waitForTransactionReceipt({ hash: h }));
    const n = await freshBatch();
    const o = order({ amountIn: 2_000_000_000n });
    const salt = newSalt();
    await answerFor(market, M, "commitmentOf", [n, A()], orderCommitment(n, A(), o, salt));
    const wrong = await fetch(`${baseUrl}/v1/markets/relay/reveals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ market, batch: n.toString(), account: A(), order: { ...o, amountIn: "1", limitPrice: o.limitPrice.toString() }, salt }),
    });
    expect(wrong.status).toBe(400);
    const q = await api.relayReveal(market, n, A(), o, salt);
    expect(q).toEqual({
      market: getAddress(market), batch: n.toString(), account: A(), status: "queued",
      revealsFrom: Number(end0 + n * PERIOD - REVEAL), revealsBy: Number(end0 + n * PERIOD), tx: null, reason: null,
    });
    expect(await api.relayReveal(market, n, A(), o, salt)).toEqual(q); // the same order again: still one entry
    const status = await fetch(`${baseUrl}/v1/markets/relay/reveals/${market}/${n}/${A()}`);
    expect((await status.text()).toLowerCase()).not.toContain(salt.slice(2).toLowerCase());
    expect((await fetch(`${baseUrl}/v1/markets/relay/reveals/${market}/${n}/${B()}`)).status).toBe(404);
    await expect(api.relayReveal(market, 0n, A(), o, salt)).rejects.toThrow(/reveal period for this batch has ended/); // batch 0 is long over
    const bad = await fetch(`${baseUrl}/v1/markets/relay/reveals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market, batch: "1" }) });
    expect(bad.status).toBe(400);

    // before the reveal window: nothing is sent
    const relay = new MarketRelay(cfg, makeChain(cfg), sql, relayKey);
    let pass = await relay.passOnce();
    expect(pass.steps).toEqual([]);
    expect(await relay.secondsUntilNext(pass.now)).toBeGreaterThan(0n);

    // the reveal window opens: revealFor from the relay key, with the trader's order and salt
    await warp({ pub: c.pub }, end0 + n * PERIOD - REVEAL - (await now()));
    pass = await relay.passOnce();
    expect(pass.steps).toEqual([expect.objectContaining({ account: A(), status: "sent" })]);
    const tx = await c.pub.getTransaction({ hash: pass.steps[0]!.txHash! });
    expect(tx.input).toBe(marketCalls.revealFor(A(), o, salt));
    expect(tx.to!.toLowerCase()).toBe(market.toLowerCase());
    expect(tx.from.toLowerCase()).toBe(relayer().toLowerCase());
    expect(await api.relayStatus(market, n, A())).toMatchObject({ status: "sent", tx: pass.steps[0]!.txHash });
    expect((await relay.passOnce()).steps).toEqual([]); // once
  });

  it("marks an order its wallet revealed first, refuses on a final revert, and gives up when the window closes", async () => {
    const n = await freshBatch();
    const [oB, oC, sB, sC] = [order({}), order({ sellAsset: true }), newSalt(), newSalt()];
    await answerFor(market, M, "commitmentOf", [n, B()], orderCommitment(n, B(), oB, sB));
    await answerFor(market, M, "commitmentOf", [n, C()], orderCommitment(n, C(), oC, sC));
    await api.relayReveal(market, n, B(), oB, sB);
    await api.relayReveal(market, n, C(), oC, sC);
    await warp({ pub: c.pub }, end0 + n * PERIOD - REVEAL - (await now()));
    // B's wallet revealed itself; the indexer has it
    await emit(market, MARKET_EVENTS, "Committed", { batch: n, account: B(), commitment: orderCommitment(n, B(), oB, sB), orryBurned: 0n });
    const own = await emit(market, MARKET_EVENTS, "Revealed", { batch: n, account: B(), order: abiOrder(oB) });
    await catchUp();
    // C: the market answers WrongPhase (not final: retried), then the window closes
    await revertWith(market, M, "revealFor", "WrongPhase");
    const relay = new MarketRelay(cfg, makeChain(cfg), sql, relayKey);
    let pass = await relay.passOnce();
    const by = Object.fromEntries(pass.steps.map((s) => [s.account, s]));
    expect(by[B()]).toMatchObject({ status: "revealed", txHash: own.transactionHash });
    expect(by[C()]).toMatchObject({ status: "waiting", reason: "WrongPhase" });
    expect(await api.relayStatus(market, n, B())).toMatchObject({ status: "revealed", tx: own.transactionHash });
    await warp({ pub: c.pub }, end0 + n * PERIOD - (await now()));
    pass = await relay.passOnce();
    expect(pass.steps).toEqual([expect.objectContaining({ account: C(), status: "failed", reason: "window closed" })]);
    expect(await api.relayStatus(market, n, C())).toMatchObject({ status: "failed", reason: "The reveal window closed before the order could be revealed." });

    // a final revert (BelowMinimum) fails at once
    const m2 = await freshBatch();
    const s2 = newSalt();
    await answerFor(market, M, "commitmentOf", [m2, C()], orderCommitment(m2, C(), oC, s2));
    await api.relayReveal(market, m2, C(), oC, s2);
    await revertWith(market, M, "revealFor", "BelowMinimum");
    await warp({ pub: c.pub }, end0 + m2 * PERIOD - REVEAL - (await now()));
    pass = await relay.passOnce();
    expect(pass.steps).toEqual([expect.objectContaining({ account: C(), status: "failed", reason: "BelowMinimum" })]);
    await revertWith(market, M, "revealFor", "BelowMinimum", false);
  });

  it("is held unless swap or darkpool is open", async () => {
    // the runtime release switch: swap and darkpool held in the releases table, stocks open
    await setRelease(sql, "swap", null, "test");
    await setRelease(sql, "darkpool", null, "test");
    try {
      const r = await app.inject({ method: "POST", url: "/v1/markets/relay/reveals", payload: {} });
      expect(r.statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/v1/markets" })).statusCode).toBe(200);
    } finally {
      for (const f of ["swap", "darkpool"]) await setRelease(sql, f, new Date(0), "test");
    }
  });
});

describe("release switch", () => {
  it("held market features answer the 404 of an unknown route; the feature names need the factory", async () => {
    for (const f of ["stocks", "swap", "darkpool"]) await setRelease(sql, f, null, "test");
    try {
      for (const path of ["/v1/markets", `/v1/markets/${market}`, `/v1/markets/${market}/batches/0`, `/v1/markets/accounts/${A()}/orders`]) {
        const r = await app.inject({ method: "GET", url: path });
        const unknown = await app.inject({ method: "GET", url: "/v1/nothing-here" });
        expect(r.statusCode, path).toBe(404);
        expect(r.body).toBe(unknown.body.replace("/v1/nothing-here", path));
      }
    } finally {
      for (const f of ["stocks", "swap", "darkpool"]) await setRelease(sql, f, new Date(0), "test");
    }
    const open = loadConfig(env({ ORRERY_ORRY_FEATURES: "darkpool" }));
    expect([...open.orryFeatures]).toEqual(["darkpool"]);
    expect(() => loadConfig(env({ ORRERY_MARKET_FACTORY: "", ORRERY_ORRY_FEATURES: "stocks" }))).toThrow(/ORRERY_MARKET_FACTORY/);
    const def = loadConfig({ ...env(), ORRERY_ORRY_TOKEN: "", ORRERY_ORRY_FEATURES: undefined as unknown as string });
    expect(["stocks", "swap", "darkpool"].every((f) => def.orryFeatures.has(f as never))).toBe(true); // 31337 default: open
  });
});

describe("market keeper", () => {
  it("roundHint is the latest round at or before revealEnd, walking back within the phase", async () => {
    const chain = makeChain(cfg);
    const end = 1_000_000n;
    await answer(feed, aggregatorV3Abi as Abi, "latestRoundData", round(PHASE | 10n, 1n, end - 5n));
    expect(await roundHintFor(chain, feed, end)).toBe(PHASE | 10n); // the latest round is at or before revealEnd
    await answer(feed, aggregatorV3Abi as Abi, "latestRoundData", round(PHASE | 10n, 1n, end + 50n));
    await answerFor(feed, aggregatorV3Abi as Abi, "getRoundData", [PHASE | 9n], round(PHASE | 9n, 1n, end + 1n));
    await answerFor(feed, aggregatorV3Abi as Abi, "getRoundData", [PHASE | 8n], round(PHASE | 8n, 1n, end));
    expect(await roundHintFor(chain, feed, end)).toBe(PHASE | 8n); // updatedAt == revealEnd counts
    await answerFor(feed, aggregatorV3Abi as Abi, "getRoundData", [PHASE | 8n], round(PHASE | 8n, 1n, end + 1n));
    expect(await roundHintFor(chain, feed, end, 2)).toBeNull(); // walk exhausted
    expect(await roundHintFor(chain, feed, end)).toBeNull(); // round 7 cannot be read
  });

  it("clears a batch with reveals at the first block after its window, with the hint; skips empty, cleared and stale batches", async () => {
    const chain = makeChain(cfg);
    const key = anvilKey(12);
    await warp({ pub: c.pub }, 2n * PERIOD); // two more batches end with no orders: nothing to clear
    await (c.wallet(ROLE.deployer)).sendTransaction({ to: c.address(12), value: E18, chain: foundry, account: c.wallet(ROLE.deployer).account }).then((h) => c.pub.waitForTransactionReceipt({ hash: h }));
    // batches 0 and 1 have ended; 1 has reveals, 0 was cleared; the feed's latest round predates batch 1's reveal end
    const t = await now();
    const ended = (t - end0) / PERIOD;
    const target = ended + 1n; // the batch whose reveal window ends next
    const targetEnd = end0 + target * PERIOD;
    await answer(feed, aggregatorV3Abi as Abi, "latestRoundData", round(PHASE | 20n, 25_000_000_000n, targetEnd - 600n));
    await answerFor(market, M, "orderCount", [target], 2n);
    await answerFor(market, M, "result", [0n], { ...emptyResult, cleared: true });
    await answerFor(market, M, "orderCount", [0n], 2n);
    const keeper = new MarketKeeper(cfg, chain, key);
    let pass = await keeper.passOnce();
    expect(pass.steps).toEqual([]); // batch 0 is cleared, the others have no orders, the target has not ended
    expect(keeper.secondsUntilNext(pass.now)).toBe(targetEnd - pass.now);

    // the block time reaches the target's reveal end: simulated, then sent with the hint
    const before = await c.pub.readContract({ address: market, abi: orryStandInAbi, functionName: "callCount", args: [toFunctionSelector(getAbiItem({ abi: M, name: "clear" }) as never)] });
    await warp({ pub: c.pub }, targetEnd - (await now()));
    pass = await keeper.passOnce();
    expect(pass.steps).toEqual([expect.objectContaining({ market: getAddress(market), batch: target.toString(), status: "sent", roundHint: (PHASE | 20n).toString() })]);
    const after = await c.pub.readContract({ address: market, abi: orryStandInAbi, functionName: "callCount", args: [toFunctionSelector(getAbiItem({ abi: M, name: "clear" }) as never)] });
    expect(after - before).toBe(1n);
    const tx = await c.pub.getTransaction({ hash: pass.steps[0]!.txHash! });
    expect(tx.input).toBe(marketCalls.clear(target, PHASE | 20n));
    expect(tx.from.toLowerCase()).toBe(c.address(12).toLowerCase());
    expect((await keeper.passOnce()).steps).toEqual([]); // once

    // next batch: a stale feed reverts StalePrice: skipped, not retried; WrongPhase: retried at the next block
    const next = target + 1n;
    await answerFor(market, M, "orderCount", [next], 1n);
    await revertWith(market, M, "clear", "StalePrice");
    await warp({ pub: c.pub }, end0 + next * PERIOD - (await now()));
    pass = await keeper.passOnce();
    expect(pass.steps).toEqual([expect.objectContaining({ batch: next.toString(), status: "skipped", reason: "StalePrice" })]);
    expect((await keeper.passOnce()).steps).toEqual([]);
    const third = next + 1n;
    await answerFor(market, M, "orderCount", [third], 1n);
    await revertWith(market, M, "clear", "WrongPhase");
    await warp({ pub: c.pub }, end0 + third * PERIOD - (await now()));
    pass = await keeper.passOnce();
    expect(pass.steps).toEqual([expect.objectContaining({ batch: third.toString(), status: "skipped", reason: "WrongPhase" })]);
    expect(keeper.secondsUntilNext(pass.now)).toBe(0n);
    await revertWith(market, M, "clear", "WrongPhase", false);
    await mine({ pub: c.pub });
    pass = await keeper.passOnce();
    expect(pass.steps).toEqual([expect.objectContaining({ batch: third.toString(), status: "sent" })]);
  });

  it("a dry run sends nothing", async () => {
    const keeper = new MarketKeeper(cfg, makeChain(cfg), anvilKey(12));
    const fourth = (await now() - end0) / PERIOD + 1n;
    await answerFor(market, M, "orderCount", [fourth], 1n);
    await keeper.passOnce();
    await warp({ pub: c.pub }, end0 + fourth * PERIOD - (await now()));
    const nonce = await c.pub.getTransactionCount({ address: c.address(12) });
    const pass = await keeper.passOnce({ dryRun: true });
    expect(pass.steps).toEqual([expect.objectContaining({ batch: fourth.toString(), status: "skipped", reason: "dry run" })]);
    expect(await c.pub.getTransactionCount({ address: c.address(12) })).toBe(nonce);
  });
});
