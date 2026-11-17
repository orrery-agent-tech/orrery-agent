# Orrery services

TypeScript (Node 22+, pnpm) implementation of `../14-services-spec.md`:

| Package | Contents |
| :--- | :--- |
| `@orrery/shared` | Generated contract ABIs, chain definitions, EIP-712 types (check result, session consent, EIP-3009) and x402 v2 wire types |
| `@orrery/server` | HTTP API (credit packs, API keys, signed readings, public reads) with a built-in x402 facilitator for USDG, an SSRF-guarded endpoint prober, and the chain indexer. Runs as three processes: `api` (facilitator included), `prober`, `indexer` |
| `@orrery/sdk` | Operator calls and signer consent, `AgentClient` (float refills, gas, x402 fetch), the counterparty client `OrreryApi`, and `verifyCheck` |
| `@orrery/web` | Next.js 16 web app in the observatory style: landing page with a live payer console, signer and agent records, credits (x402 purchase, key rotation, signed readings verified in the browser), the operator workspace (Safe 1-of-1) and docs |

Status 2026-11-07: built and tested locally against anvil and Postgres; not deployed; hosting not decided.

## Commands

```bash
pnpm install
pnpm gen:abi            # after any contract change: reads ../contracts/out
pnpm typecheck
pnpm test               # starts anvil on :8546 and Postgres (Docker) on :55432, stops both afterwards
```

Run a process (after `pnpm --filter @orrery/server migrate`):

```bash
pnpm --filter @orrery/server api
pnpm --filter @orrery/server indexer
pnpm --filter @orrery/server prober
```

## Local stack (development)

Launch configurations live in the workspace `.claude/launch.json`: `orrery-anvil` (:8546), `orrery-pg` (:55433),
`orrery-api` (:8787), `orrery-web` (:3100). After anvil is up, `pnpm exec tsx scripts/seed-local.ts` deploys the
contracts, opens one agent session and writes `.local/api.env` and `packages/web/.env.local`.

Web variables: `NEXT_PUBLIC_CHAIN_ID` (default 4663), `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_API_URL`,
`NEXT_PUBLIC_MODULE`, `NEXT_PUBLIC_ATTESTOR`, `NEXT_PUBLIC_LENS`, `NEXT_PUBLIC_REGISTRY`, `NEXT_PUBLIC_USDG` (defaults to
USDG on 4663). Contract addresses have no default; without them the pages show their forward state ("opens soon").
API: `ORRERY_CORS_ORIGINS` (default the local web origins).

## Configuration

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `ORRERY_CHAIN_ID` | `31337` | 4663 mainnet, 46630 development network |
| `ORRERY_RPC_URL` | `http://127.0.0.1:8545` | Use a request-priced endpoint with history for the indexer (14 §6) |
| `ORRERY_DATABASE_URL` | `postgres://orrery:orrery@127.0.0.1:55432/orrery` | |
| `ORRERY_PORT`, `ORRERY_PUBLIC_URL` | `8787`, `http://127.0.0.1:8787` | The public URL host appears in the key-rotation message |
| `ORRERY_MODULE`, `ORRERY_ATTESTOR`, `ORRERY_LENS`, `ORRERY_REGISTRY`, `ORRERY_USDG`, `ORRERY_TREASURY` | none | **Placeholders: required, real deployment addresses** |
| `ORRERY_USDG_NAME`, `ORRERY_USDG_VERSION` | `Global Dollar`, `1` | USDG EIP-712 domain on 4663 (measured) |
| `ORRERY_PACK_PRICE`, `ORRERY_PACK_SIZE` | `1000000` (1 USDG), `500` | Credits per pack; one credit is 0.002 USDG (R-58) |
| `ORRERY_FREE_CHECKS_PER_MONTH`, `ORRERY_FREE_CHECKS_PER_DAY` | `1000`, `250000` | Free checks per address per UTC month, used before credits; the daily figure caps free checks across all addresses (past it, checks use credits until the next UTC day) |
| `ORRERY_CREDITS_PER_CHECK`, `ORRERY_VOLUME_CREDITS_PER_CHECK`, `ORRERY_VOLUME_CHECKS` | `2`, `1`, `100000` | A check costs 2 credits (0.004 USDG), 1 credit (0.002 USDG) past 100,000 checks in the address's month |
| `ORRERY_PLAN_PRICE`, `ORRERY_PLAN_CREDITS`, `ORRERY_PLAN_DAYS` | `99000000` (99 USDG), `49500`, `30` | Platform plan, bought with `POST /v1/credits?product=plan`: its price in credits at the pack rate, every check at the volume cost while it runs; a second purchase extends it. Must differ from the pack price (the facilitator tells them apart by amount) |
| `ORRERY_CHECKS_PER_MINUTE`, `ORRERY_PLAN_CHECKS_PER_MINUTE` | `120`, `1200` | Signed checks per address per minute, without and with the plan |
| `ORRERY_CONFIRMATIONS` | `10` | About 1 s on 4663 |
| `ORRERY_RELAYER_KEY[_FILE]`, `ORRERY_CHECK_SIGNER_KEY[_FILE]`, `ORRERY_ATTESTER_KEY[_FILE]` | anvil keys on 31337 only | **Required on any other chain**; files live in `~/.secrets/<project>/` (a JSON `{ "privateKey": ... }` or raw hex) |
| `ORRERY_IPFS_GATEWAY` | `https://ipfs.io/ipfs/` | |
| `ORRERY_PROBE_FRESH_SECONDS` | `600` | A paid check reprobes when the cached probe is older |
| `ORRERY_PROBE_ALLOW_PRIVATE` | off | Honoured only on chain 31337, for tests |
| `ORRERY_PUBLIC_RATE_PER_MINUTE` | `60` | Public read endpoints, per IP |
| `ORRERY_TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Peers allowed to set X-Forwarded-For: Caddy on the host or in a Docker network. A public peer is never trusted. `off` disables |
| `ORRERY_INDEXER_START_BLOCK`, `ORRERY_INDEXER_MAX_LAG`, `ORRERY_INDEXER_HEALTH_PORT` | `0`, `600`, `8788` | Health is lag against the head |

## Test results (2026-11-08)

`pnpm test`: 39 passed. Added (8, `test/api-hardening.unit.test.ts`): a failed chain read answers 503 without the RPC
URL; an unhandled error answers 500 with a fixed message and logs with URLs removed; a malformed body answers 400 in our
words; visitors behind a private-range proxy get their own limiter bucket; a public peer cannot escape the limit with a
forged X-Forwarded-For; the trust setting parses; the limiter map stays under its cap and forgets idle buckets. Each
fix was removed once and the suite failed (4 of 4).

## Test results (2026-11-07)

`pnpm test`: 31 passed. Integration (10): a pack sold over x402 and one API key issued; an agent paying from its float
topped up within the caps; a replayed payment never granted twice; a nonce already used on-chain found and granted once;
a check of the paying address whose EIP-712 signature verifies against an active check signer, with no validity window
on an unknown account kind; credits never below zero under 10 parallel requests with 3 credits; check pricing (R-58:
free allowance first, 2 then 1 credit past the monthly volume, the plan, the daily free cap, parallel checks); key rotation with a
single-use signed message; a verified agent probed, attested on-chain, and the probe carried in the check; the prober
refusing private, metadata, IPv4-mapped and credentialed URLs; the indexer reaching lag 0. Unit (21): public-address
classification.

Web app (2026-11-07): `next build` passes (8 routes). Clicked through in the browser against the local stack with a
test EIP-6963 provider on anvil accounts: the landing console reads a session from the chain; a pack bought over x402
(500 credits, key shown once); a signed check verified in the browser against the on-chain check signer; on the
operator page a decrease applied at once and an increase proposed with its one-hour countdown. No horizontal scroll at
375 px on any page.

Not covered yet: a live run on 4663 or 46630 (hosting and keys are owner decisions), a real Safe in the web app (the
local run used the development account), binding identity through the web app on a real registry, Kernel accounts,
load tests.
