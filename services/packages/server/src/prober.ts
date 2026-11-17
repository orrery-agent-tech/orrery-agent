import { keccak256, parseAbi, type Address, type Hex } from "viem";
import { orreryAttestorAbi } from "@orrery/shared";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import { ProbeError, safeFetch } from "./ssrf.js";

/** Prober (14 §5): registration file, advertised HTTPS services, optional domain proof, on-chain attestation. */

const registryAbi = parseAbi(["function tokenURI(uint256 agentId) view returns (string)"]);
const MAX_SERVICES = 10;
const ATTEST_TTL = 7n * 24n * 3600n;

export interface ProbeResult {
  agentId: bigint;
  probedAt: number; // unix seconds
  endpointsLive: boolean;
  registrationValid: boolean;
  domainVerified: boolean;
  registrationHash: Hex;
  detail: { uri: string; services: { endpoint: string; live: boolean; error?: string }[]; error?: string };
}

interface Registration {
  type?: unknown;
  name?: unknown;
  services?: { name?: unknown; endpoint?: unknown }[];
  registrations?: { agentRegistry?: unknown; agentId?: unknown }[];
}

const lastHit = new Map<string, number>();
function hostAllowed(host: string): boolean {
  const now = Date.now();
  const prev = lastHit.get(host) ?? 0;
  if (now - prev < 60_000) return false;
  lastHit.set(host, now);
  return true;
}

export function resetHostLimiter(): void {
  lastHit.clear();
}

async function loadUri(cfg: Config, uri: string): Promise<Buffer> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new ProbeError("bad data uri");
    const meta = uri.slice(5, comma);
    const data = uri.slice(comma + 1);
    const buf = meta.endsWith(";base64") ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf8");
    if (buf.length > 256 * 1024) throw new ProbeError("registration too large");
    return buf;
  }
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    return (await safeFetch(cfg.ipfsGateway + path, { allowPrivate: cfg.probeAllowPrivate })).body;
  }
  const res = await safeFetch(uri, { allowPrivate: cfg.probeAllowPrivate });
  if (res.status < 200 || res.status >= 300) throw new ProbeError(`registration http ${res.status}`);
  return res.body;
}

function matchesRegistration(cfg: Config, reg: Registration, agentId: bigint): boolean {
  const want = `eip155:${cfg.chainId}:${cfg.addresses.registry}`.toLowerCase();
  return (reg.registrations ?? []).some(
    (r) => typeof r.agentRegistry === "string" && r.agentRegistry.toLowerCase() === want && BigInt(String(r.agentId)) === agentId,
  );
}

export async function probeAgent(cfg: Config, chain: Chain, agentId: bigint): Promise<ProbeResult> {
  const probedAt = Math.floor(Date.now() / 1000);
  const base: ProbeResult = {
    agentId,
    probedAt,
    endpointsLive: false,
    registrationValid: false,
    domainVerified: false,
    registrationHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    detail: { uri: "", services: [] },
  };
  let uri: string;
  try {
    uri = await chain.public.readContract({ address: cfg.addresses.registry, abi: registryAbi, functionName: "tokenURI", args: [agentId] });
  } catch {
    return { ...base, detail: { ...base.detail, error: "no token uri" } };
  }
  base.detail.uri = uri;
  let raw: Buffer;
  let reg: Registration;
  try {
    raw = await loadUri(cfg, uri);
    reg = JSON.parse(raw.toString("utf8")) as Registration;
  } catch (e) {
    return { ...base, detail: { ...base.detail, error: e instanceof Error ? e.message : "registration unreadable" } };
  }
  base.registrationHash = keccak256(raw);
  const shapeOk = typeof reg.type === "string" && typeof reg.name === "string" && Array.isArray(reg.services);
  base.registrationValid = shapeOk && matchesRegistration(cfg, reg, agentId);

  const scheme = cfg.probeAllowPrivate ? /^https?:\/\//i : /^https:\/\//i;
  const endpoints = (reg.services ?? [])
    .map((s) => (typeof s.endpoint === "string" ? s.endpoint : ""))
    .filter((e) => scheme.test(e))
    .slice(0, MAX_SERVICES);
  for (const endpoint of endpoints) {
    const host = new URL(endpoint).host;
    if (!cfg.probeAllowPrivate && !hostAllowed(host)) {
      base.detail.services.push({ endpoint, live: false, error: "host probed less than a minute ago" });
      continue;
    }
    try {
      const res = await safeFetch(endpoint, { allowPrivate: cfg.probeAllowPrivate });
      base.detail.services.push({ endpoint, live: res.status >= 200 && res.status < 300 });
    } catch (e) {
      base.detail.services.push({ endpoint, live: false, error: e instanceof Error ? e.message : "probe failed" });
    }
  }
  base.endpointsLive = base.detail.services.length > 0 && base.detail.services.every((s) => s.live);

  // Domain proof (ERC-8004): the first HTTPS service domain serves /.well-known/agent-registration.json with this agent.
  const first = endpoints[0];
  if (base.registrationValid && first) {
    const domain = new URL(first);
    const uriHost = /^https?:\/\//i.test(uri) ? new URL(uri).host : "";
    if (uriHost && uriHost === domain.host) {
      base.domainVerified = true;
    } else {
      try {
        const res = await safeFetch(`${domain.protocol}//${domain.host}/.well-known/agent-registration.json`, {
          allowPrivate: cfg.probeAllowPrivate,
        });
        if (res.status >= 200 && res.status < 300) {
          base.domainVerified = matchesRegistration(cfg, JSON.parse(res.body.toString("utf8")) as Registration, agentId);
        }
      } catch {
        base.domainVerified = false;
      }
    }
  }
  return base;
}

export async function storeProbe(sql: Sql, r: ProbeResult): Promise<void> {
  await sql`insert into probes (agent_id, probed_at, endpoints_live, registration_valid, domain_verified, registration_hash, detail)
    values (${r.agentId.toString()}, to_timestamp(${r.probedAt}), ${r.endpointsLive}, ${r.registrationValid}, ${r.domainVerified},
      ${r.registrationHash}, ${sql.json(r.detail as never)})
    on conflict (agent_id) do update set probed_at = excluded.probed_at, endpoints_live = excluded.endpoints_live,
      registration_valid = excluded.registration_valid, domain_verified = excluded.domain_verified,
      registration_hash = excluded.registration_hash, detail = excluded.detail`;
}

export interface StoredProbe {
  probedAt: number;
  endpointsLive: boolean;
  registrationValid: boolean;
  domainVerified: boolean;
  registrationHash: Hex;
  attestedAt: number | null;
}

export async function loadProbe(sql: Sql, agentId: bigint): Promise<StoredProbe | null> {
  const [row] = await sql<
    { probed_at: Date; endpoints_live: boolean; registration_valid: boolean; domain_verified: boolean; registration_hash: string; attested_at: Date | null }[]
  >`select probed_at, endpoints_live, registration_valid, domain_verified, registration_hash, attested_at from probes where agent_id = ${agentId.toString()}`;
  if (!row) return null;
  return {
    probedAt: Math.floor(row.probed_at.getTime() / 1000),
    endpointsLive: row.endpoints_live,
    registrationValid: row.registration_valid,
    domainVerified: row.domain_verified,
    registrationHash: row.registration_hash as Hex,
    attestedAt: row.attested_at ? Math.floor(row.attested_at.getTime() / 1000) : null,
  };
}

/** Posts an attestation when the result changed or the last one is older than 24 hours (gas). */
export async function attestIfNeeded(cfg: Config, chain: Chain, sql: Sql, r: ProbeResult, previous: StoredProbe | null): Promise<Hex | null> {
  const verified = await chain.public.readContract({ address: cfg.addresses.attestor, abi: orreryAttestorAbi, functionName: "isVerified", args: [r.agentId] });
  if (!verified) return null;
  const changed =
    !previous ||
    previous.endpointsLive !== r.endpointsLive ||
    previous.registrationValid !== r.registrationValid ||
    previous.domainVerified !== r.domainVerified ||
    previous.registrationHash !== r.registrationHash;
  const stale = !previous?.attestedAt || r.probedAt - previous.attestedAt > 24 * 3600;
  if (!changed && !stale) return null;
  const block = await chain.public.getBlock();
  const observedAt = block.timestamp < BigInt(r.probedAt) ? block.timestamp : BigInt(r.probedAt);
  const wallet = chain.wallet(cfg.attesterKey);
  const hash = await wallet.writeContract({
    address: cfg.addresses.attestor,
    abi: orreryAttestorAbi,
    functionName: "attest",
    args: [
      r.agentId,
      {
        observedAt,
        expiresAt: block.timestamp + ATTEST_TTL,
        endpointsLive: r.endpointsLive,
        registrationValid: r.registrationValid,
        domainVerified: r.domainVerified,
        registrationHash: r.registrationHash,
        attester: wallet.account.address as Address,
      },
    ],
    chain: null,
    account: wallet.account,
  });
  await chain.public.waitForTransactionReceipt({ hash });
  await sql`update probes set attested_at = now(), attest_tx = ${hash} where agent_id = ${r.agentId.toString()}`;
  return hash;
}

