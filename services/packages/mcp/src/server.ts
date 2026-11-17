import { writeFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, parseAbi, type Account, type Address, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  AgentClient,
  DATA_DATASETS,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  decodeHeader,
  encodeHeader,
  signPermit2Payment,
  verifyCheck,
  verifyDataResponse,
  type CheckResponse,
  type DataCatalogResponse,
  type DataPaymentRequirements,
  type DataResponse,
  type PaymentRequired,
  type PaymentRequirements,
  type PublicPaymentRequirements,
} from "@orrery/sdk";
import type { McpConfig } from "./config.js";

/**
 * `@orrery/mcp` (`docs/UPDATE-CANDIDATES.md` 3.6, `docs/updates/L2-DATA-MCP-SPEC.md` D-16). Counterparty tools use the
 * Orrery API key; agent tools sign with the session signer's key, held on the agent's own machine; every tool says what
 * it costs, paid tools report what is left and warn below 20% of a pack, and a payment above the configured amount
 * needs `confirm: true` from the caller.
 */

export const VERSION = "0.1.0";
const LOW = 0.2;
const erc20Abi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const ok = (v: unknown): Text => ({ content: [{ type: "text", text: json(v) }] });
const fail = (message: string): Text => ({ content: [{ type: "text", text: message }], isError: true });

export interface McpDeps {
  config: McpConfig;
  /** Override the RPC client (tests). */
  publicClient?: PublicClient;
  fetch?: typeof fetch;
}

export function createOrreryMcpServer(deps: McpDeps): McpServer {
  const cfg = deps.config;
  const doFetch = deps.fetch ?? fetch;
  const chain = defineChain({ id: cfg.chainId, name: `chain-${cfg.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  const publicClient = deps.publicClient ?? (createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient);
  const wallet = cfg.agentKey ? (createWalletClient({ chain, transport: http(cfg.rpcUrl), account: privateKeyToAccount(cfg.agentKey) }) as WalletClient & { account: Account }) : null;
  const agent = wallet ? new AgentClient(wallet, publicClient, cfg.module) : null;
  let apiKey = cfg.apiKey;
  let dataSigner: Address | null = null;

  async function api<T>(path: string, init: { key?: boolean; method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.key) {
      if (!apiKey) throw new Error("Set ORRERY_API_KEY to use this tool, or get a key by buying a data pack with orrery_data_buy_pack.");
      headers.authorization = `Bearer ${apiKey}`;
    }
    const r = await doFetch(`${cfg.apiUrl}${path}`, { method: init.method ?? "GET", headers });
    const body = (await r.json().catch(() => ({}))) as T;
    return { status: r.status, body, headers: r.headers };
  }
  const errorOf = (b: unknown, status: number) => (b as { error?: string })?.error ?? `Orrery API returned HTTP ${status}.`;

  async function signer(): Promise<Address> {
    if (!dataSigner) dataSigner = getAddress((await api<{ signer: string }>("/v1/data/signer")).body.signer);
    return dataSigner;
  }

  /** Keeps a key issued by a purchase: saved to ORRERY_API_KEY_FILE (mode 600) when set, else held for this session. */
  function keepKey(key: string | undefined): string | null {
    if (!key) return null;
    apiKey = key;
    if (cfg.apiKeyFile && !existsSync(cfg.apiKeyFile)) {
      writeFileSync(cfg.apiKeyFile, key, { mode: 0o600 });
      return `New Orrery API key saved to ${cfg.apiKeyFile}.`;
    }
    return "New Orrery API key held in memory until this session ends. Point ORRERY_API_KEY_FILE at a path to save the next one.";
  }

  async function creditsNotice(): Promise<{ credits: string; freeChecksLeft: number; notice?: string } | null> {
    const r = await api<{ credits: string; month: { freeChecksLeft: number } }>("/v1/credits", { key: true }).catch(() => null);
    if (!r || r.status !== 200) return null;
    const pricing = await api<{ packSize: number }>("/v1/pricing").catch(() => null);
    const pack = pricing?.body.packSize ?? 500;
    const low = BigInt(r.body.credits) < BigInt(Math.ceil(pack * LOW)) && r.body.month.freeChecksLeft === 0;
    return { credits: r.body.credits, freeChecksLeft: r.body.month.freeChecksLeft, ...(low ? { notice: `${r.body.credits} check credits remain, less than 20% of one ${pack} credit pack.` } : {}) };
  }

  const server = new McpServer({ name: "orrery", version: VERSION });

  // ---------------------------------------------------------------- free reads

  server.registerTool(
    "orrery_pricing",
    { title: "Price list", description: "No charge. What checks cost (monthly free allowance, credits per check, credit packs, platform plan) and what Orrery Data packs cost in USDG and ORRY.", inputSchema: {} },
    async () => {
      const [checks, data] = await Promise.all([api("/v1/pricing"), api<DataCatalogResponse>("/v1/data").catch(() => null)]);
      return ok({ checks: checks.body, data: data && data.status === 200 ? data.body.pricing : null });
    },
  );

  server.registerTool(
    "orrery_signer_record",
    { title: "Look up a signer", description: "No charge. Orrery's public entry for a session signer address: the account and agent behind it, its policy, caps and status.", inputSchema: { address: z.string().describe("signer address (0x)") } },
    async ({ address }) => {
      if (!isAddress(address)) return fail("Expected a 0x address.");
      const r = await api(`/v1/signers/${address}`);
      return r.status === 200 ? ok(r.body) : fail(errorOf(r.body, r.status));
    },
  );

  server.registerTool(
    "orrery_agent_record",
    {
      title: "Look up an agent",
      description: "No charge. Orrery's public entry for an ERC-8004 agent: verification, attestation and endpoints, plus the policy when you pass its account.",
      inputSchema: { agentId: z.string().regex(/^\d+$/).describe("numeric ERC-8004 agent id"), account: z.string().optional().describe("smart account of the agent (0x)") },
    },
    async ({ agentId, account }) => {
      if (account && !isAddress(account)) return fail("account must be a 0x address.");
      const r = await api(`/v1/agents/${agentId}${account ? `?account=${account}` : ""}`);
      return r.status === 200 ? ok(r.body) : fail(errorOf(r.body, r.status));
    },
  );

  server.registerTool(
    "orrery_verify_check",
    { title: "Verify a signed reading", description: "No charge, one chain read. Confirms a signed Orrery reading: the signature is valid, the signer is an active check signer, and the reading has not expired.", inputSchema: { check: z.record(z.string(), z.unknown()).describe("the full response from orrery_check_payer or orrery_check_agent") } },
    async ({ check }) => {
      const v = await verifyCheck(publicClient, cfg.attestor, check as unknown as CheckResponse);
      return ok({ ok: v.ok, reason: v.reason ?? null, version: v.version ?? null });
    },
  );

  // ---------------------------------------------------------------- counterparty (API key)

  const checkTool = async (path: string) => {
    const r = await api<CheckResponse>(path, { key: true });
    if (r.status !== 200) return fail(errorOf(r.body, r.status));
    const v = await verifyCheck(publicClient, cfg.attestor, r.body).catch(() => ({ ok: false, reason: "attestor contract unreadable" }));
    return ok({ check: r.body, verified: v.ok, reason: (v as { reason?: string }).reason ?? null, account: await creditsNotice() });
  };

  server.registerTool(
    "orrery_check_payer",
    {
      title: "Take a reading of a payer",
      description: "Uses one check, drawn from this month's free checks before any check credits (prices in orrery_pricing). Requires ORRERY_API_KEY. Returns a signed reading of the agent behind a paying address, verified on chain, plus your remaining credits.",
      inputSchema: { address: z.string().describe("paying address (0x), usually an agent's session signer") },
    },
    async ({ address }) => (isAddress(address) ? checkTool(`/v1/check/by-signer/${address}`) : fail("Expected a 0x address.")),
  );

  server.registerTool(
    "orrery_check_agent",
    {
      title: "Take a reading of an agent",
      description: "Uses one check, drawn from this month's free checks before any check credits (prices in orrery_pricing). Requires ORRERY_API_KEY. Returns a signed reading of an ERC-8004 agent and its account, verified on chain, plus your remaining credits.",
      inputSchema: { agentId: z.string().regex(/^\d+$/), account: z.string().describe("smart account of the agent (0x)") },
    },
    async ({ agentId, account }) => (isAddress(account) ? checkTool(`/v1/check/by-agent/${agentId}?account=${account}`) : fail("account must be a 0x address.")),
  );

  server.registerTool(
    "orrery_credits",
    { title: "Credits", description: "No charge. Requires ORRERY_API_KEY. Shows the check credits, free checks remaining this month, plan, and data calls remaining on your key.", inputSchema: {} },
    async () => {
      const r = await api("/v1/credits", { key: true });
      if (r.status !== 200) return fail(errorOf(r.body, r.status));
      const data = await api<{ calls: string; packCalls: number; low: boolean }>("/v1/data/account", { key: true }).catch(() => null);
      return ok({ checks: r.body, data: data && data.status === 200 ? data.body : null, notice: (await creditsNotice())?.notice ?? null });
    },
  );

  // ---------------------------------------------------------------- Orrery Data

  server.registerTool(
    "orrery_data_catalog",
    { title: "Dataset catalogue", description: "No charge. Lists the official datasets, built from chain data and Orrery's own records only, with their views, filters and pack prices.", inputSchema: {} },
    async () => {
      const r = await api<DataCatalogResponse>("/v1/data");
      return r.status === 200 ? ok(r.body) : fail(errorOf(r.body, r.status));
    },
  );

  server.registerTool(
    "orrery_data_query",
    {
      title: "Read a dataset",
      description:
        "Uses one data call (call packs come from orrery_data_buy_pack, prices in orrery_pricing). Requires an Orrery API key. Each record is checked against Orrery's data signer before it is returned, along with your remaining calls.",
      inputSchema: {
        dataset: z.enum(DATA_DATASETS),
        view: z.string().optional(),
        filters: z.record(z.string(), z.string()).optional().describe("e.g. { agentId: '12' }, { symbol: 'TSLA' }"),
        limit: z.number().int().min(1).max(500).optional(),
        before: z.string().optional().describe("`next` from the previous page"),
      },
    },
    async ({ dataset, view, filters, limit, before }) => {
      const qs = new URLSearchParams({ ...(filters ?? {}), ...(view ? { view } : {}), ...(limit ? { limit: String(limit) } : {}), ...(before ? { before } : {}) });
      const r = await api<DataResponse & { error?: string }>(`/v1/data/datasets/${dataset}${qs.size ? `?${qs}` : ""}`, { key: true });
      if (r.status === 402) return fail("This key has used all its data calls. orrery_data_buy_pack adds a pack.");
      if (r.status !== 200) return fail(errorOf(r.body, r.status));
      const v = await verifyDataResponse(r.body, { signer: await signer(), chainId: cfg.chainId });
      if (!v.ok) return fail(`Withheld: the response failed verification (${v.reason}).`);
      const calls = BigInt(r.body.account?.calls ?? "0");
      const pack = await api<DataCatalogResponse>("/v1/data").then((x) => x.body.pricing.packCalls).catch(() => 1000);
      const notice = calls < BigInt(Math.ceil(pack * LOW)) ? `${calls} data calls remain, less than 20% of one ${pack} call pack.` : null;
      return ok({ verified: true, ...r.body, account: { address: r.body.account?.address, calls: r.body.account?.calls }, notice });
    },
  );

  server.registerTool(
    "orrery_data_verify",
    { title: "Verify a data response", description: "No charge, runs offline. Confirms an Orrery Data response: record and query hashes plus the data signer's EIP-712 signature.", inputSchema: { response: z.record(z.string(), z.unknown()) } },
    async ({ response }) => ok(await verifyDataResponse(response as unknown as DataResponse, { signer: await signer().catch(() => undefined), chainId: cfg.chainId })),
  );

  server.registerTool(
    "orrery_data_providers",
    { title: "Listed providers", description: "No charge. Third-party x402 data providers that staked ORRY to be listed, with endpoint, declared price per call, stake and volume over 30 days.", inputSchema: {} },
    async () => {
      const r = await api("/v1/data/providers");
      return r.status === 200 ? ok(r.body) : fail(errorOf(r.body, r.status));
    },
  );

  // ---------------------------------------------------------------- agent tools (session signer key)

  const needAgent = () => (agent ? null : fail("Set ORRERY_AGENT_KEY_FILE to the session signer's key file (mode 600) to use this tool."));
  const overCap = (usd: number, confirm: boolean | undefined) =>
    usd > cfg.maxPaymentUsd && !confirm ? fail(`${usd} USD exceeds this server's ${cfg.maxPaymentUsd} USD payment setting. Repeat the call with confirm: true to go ahead.`) : null;

  server.registerTool(
    "orrery_data_buy_pack",
    {
      title: "Buy a call pack",
      description:
        "Uses one data pack (price in orrery_pricing, 20% lower in ORRY). The agent's session signer pays from its float, inside the session caps. Requires ORRERY_AGENT_KEY_FILE, and confirm: true for anything above ORRERY_MCP_MAX_PAYMENT_USD. The first purchase issues an API key.",
      inputSchema: { asset: z.enum(["USDG", "ORRY"]).default("USDG"), confirm: z.boolean().optional() },
    },
    async ({ asset, confirm }) => {
      const missing = needAgent();
      if (missing) return missing;
      const first = await api("/v1/data/packs", { method: "POST" });
      if (first.status !== 402) return fail(errorOf(first.body, first.status));
      const required = decodeHeader<PaymentRequired>(first.headers.get(HEADER_REQUIRED)!);
      const accepts = required.accepts as unknown as DataPaymentRequirements[];
      const req = accepts.find((a) => (asset === "ORRY" ? a.extra.assetTransferMethod === "permit2" : a.extra.assetTransferMethod === "eip3009"));
      if (!req) return fail(asset === "ORRY" ? "Data packs take USDG for now. Call again with asset USDG." : "The API returned no USDG pack offer. Call again in a few seconds.");
      const usd = Number(asset === "ORRY" ? (req.extra.usd ?? "0") : req.amount) / 1e6;
      const capped = overCap(usd, confirm);
      if (capped) return capped;
      let header: string;
      if (asset === "USDG") {
        await agent!.ensureFloat(getAddress(req.asset), BigInt(req.amount));
        header = encodeHeader(await agent!.signPayment(req as unknown as PaymentRequirements, cfg.chainId, required.resource));
      } else {
        const allowance = await publicClient.readContract({ address: req.asset, abi: erc20Abi, functionName: "allowance", args: [agent!.signer, req.extra.permit2!] });
        if (allowance < BigInt(req.amount)) return fail(`Signer ${agent!.signer} needs a one-time ORRY approval for Permit2 (${req.extra.permit2}). Send that approval from the signer and call again.`);
        header = encodeHeader(await signPermit2Payment(wallet!, { chainId: cfg.chainId, requirements: req as unknown as PublicPaymentRequirements, permit2: req.extra.permit2!, proxy: req.extra.proxy! }));
      }
      for (let i = 0; i < 10; i++) {
        const r = await api<{ account?: { address: string; calls: string; apiKey?: string }; granted?: string; transaction?: string; error?: string }>("/v1/data/packs", { method: "POST", headers: { [HEADER_SIGNATURE]: header } });
        if (r.status === 202) {
          await new Promise((res) => setTimeout(res, 2_000));
          continue;
        }
        if (r.status !== 200) return fail(errorOf(r.body, r.status));
        const note = keepKey(r.body.account?.apiKey);
        return ok({ paid: { asset, amount: req.amount, usd }, calls: r.body.account?.calls, granted: r.body.granted, transaction: r.body.transaction, key: note });
      }
      return fail("Payment sent and awaiting confirmation. orrery_credits shows the new calls once it lands.");
    },
  );

  server.registerTool(
    "orrery_allowance",
    { title: "Allowance", description: "No charge, chain reads only. Requires ORRERY_AGENT_KEY_FILE. Shows what the agent can still spend today for each capped token, and how much room the float has.", inputSchema: {} },
    async () => {
      const missing = needAgent();
      if (missing) return missing;
      return ok({ signer: agent!.signer, ...(await agent!.session()), caps: await agent!.getAllowance() });
    },
  );

  server.registerTool(
    "orrery_ensure_float",
    {
      title: "Refill the float",
      description: "Gas only. Requires ORRERY_AGENT_KEY_FILE. Moves a capped token from the agent's account to the signer's float, inside the session caps, until the float holds at least `amount` base units.",
      inputSchema: { token: z.string(), amount: z.string().regex(/^\d+$/) },
    },
    async ({ token, amount }) => {
      const missing = needAgent();
      if (missing) return missing;
      if (!isAddress(token)) return fail("token must be a 0x address.");
      const tx = await agent!.ensureFloat(getAddress(token), BigInt(amount));
      return ok({ transaction: tx, toppedUp: tx !== null });
    },
  );

  server.registerTool(
    "orrery_pay_x402",
    {
      title: "Pay for an x402 resource",
      description:
        "Costs the amount the URL requests (x402 `exact`, USDG), paid from the agent's float inside the session caps. Requires ORRERY_AGENT_KEY_FILE, and confirm: true above ORRERY_MCP_MAX_PAYMENT_USD. Accepts https URLs, or localhost.",
      inputSchema: { url: z.string().url(), method: z.enum(["GET", "POST"]).default("GET"), body: z.string().max(65_536).optional(), confirm: z.boolean().optional() },
    },
    async ({ url, method, body, confirm }) => {
      const missing = needAgent();
      if (missing) return missing;
      const u = new URL(url);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return fail("Use an https URL (localhost may use http).");
      const init: RequestInit = { method, ...(body ? { body, headers: { "content-type": "application/json" } } : {}) };
      const first = await doFetch(url, init);
      if (first.status !== 402) return ok({ status: first.status, paid: false, body: await first.text() });
      const header = first.headers.get(HEADER_REQUIRED);
      if (!header) return fail("Got 402 from the URL, but no payment requirements header came with it.");
      const required = decodeHeader<PaymentRequired>(header);
      const req = required.accepts.find((a) => a.scheme === "exact" && a.network === `eip155:${cfg.chainId}` && (a.extra?.assetTransferMethod ?? "eip3009") === "eip3009");
      if (!req) return fail(`The URL offers no x402 exact payment on chain ${cfg.chainId} in a form this server supports.`);
      const capped = overCap(Number(req.amount) / 1e6, confirm);
      if (capped) return capped;
      await agent!.ensureFloat(getAddress(req.asset), BigInt(req.amount));
      const payload = await agent!.signPayment(req, cfg.chainId, required.resource);
      const headers = new Headers(init.headers);
      headers.set(HEADER_SIGNATURE, encodeHeader(payload));
      const paid = await doFetch(url, { ...init, headers });
      return ok({ status: paid.status, paid: paid.ok, amount: req.amount, asset: req.asset, payTo: req.payTo, body: await paid.text() });
    },
  );

  return server;
}
