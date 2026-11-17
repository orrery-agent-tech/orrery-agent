# Orrery services

TypeScript (Node 22+, pnpm) packages behind https://orreryagent.com and https://api.orreryagent.com.

| Package | Contents |
| :--- | :--- |
| `@orrery/shared` | Contract ABIs, chain definitions, EIP-712 types (check result, session consent, EIP-3009) and x402 v2 wire types |
| `@orrery/server` | HTTP API (credit packs, API keys, signed readings, public reads, data) with a built-in x402 facilitator for USDG, an SSRF-guarded endpoint prober, and the chain indexer. Runs as three processes: `api`, `prober`, `indexer` |
| `@orrery/sdk` | Published as `@orrery-tech/sdk`: operator calls and signer consent, `AgentClient` (float refills, gas, x402 fetch), the counterparty client `OrreryApi`, and `verifyCheck` |
| `@orrery/mcp` | Published as `@orrery-tech/mcp`: the MCP server for AI assistants |
| `@orrery/web` | The Next.js web app: landing page with a live payer console, signer and agent records, credits (x402 purchase, key rotation, signed readings verified in the browser), the operator workspace (Safe 1-of-1) and docs |

## Server configuration

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `ORRERY_CHAIN_ID` | `31337` | 4663 for Robinhood Chain |
| `ORRERY_RPC_URL` | `http://127.0.0.1:8545` | A comma list falls back in order; the indexer needs an endpoint that serves log history |
| `ORRERY_DATABASE_URL` | `postgres://orrery:orrery@127.0.0.1:55432/orrery` | |
| `ORRERY_PORT`, `ORRERY_PUBLIC_URL` | `8787`, `http://127.0.0.1:8787` | The public URL host appears in the key-rotation message |
| `ORRERY_MODULE`, `ORRERY_ATTESTOR`, `ORRERY_LENS`, `ORRERY_REGISTRY`, `ORRERY_USDG`, `ORRERY_TREASURY` | none | The deployment addresses (see the root README for Robinhood Chain) |
| `ORRERY_USDG_NAME`, `ORRERY_USDG_VERSION` | `Global Dollar`, `1` | The USDG EIP-712 domain on 4663 |
| `ORRERY_PACK_PRICE`, `ORRERY_PACK_SIZE` | `1000000` (1 USDG), `500` | Credits per pack; one credit is 0.002 USDG |
| `ORRERY_FREE_CHECKS_PER_MONTH`, `ORRERY_FREE_CHECKS_PER_DAY` | `1000`, `250000` | Free checks per address per UTC month, used before credits; the daily figure caps free checks across all addresses |
| `ORRERY_CREDITS_PER_CHECK`, `ORRERY_VOLUME_CREDITS_PER_CHECK`, `ORRERY_VOLUME_CHECKS` | `2`, `1`, `100000` | A check costs 2 credits (0.004 USDG), 1 credit (0.002 USDG) past 100,000 checks in the address's month |
| `ORRERY_PLAN_PRICE`, `ORRERY_PLAN_CREDITS`, `ORRERY_PLAN_DAYS` | `99000000` (99 USDG), `49500`, `30` | Platform plan, bought with `POST /v1/credits?product=plan`; every check at the volume cost while it runs, and a second purchase extends it |
| `ORRERY_CHECKS_PER_MINUTE`, `ORRERY_PLAN_CHECKS_PER_MINUTE` | `120`, `1200` | Signed checks per address per minute, without and with the plan |
| `ORRERY_CONFIRMATIONS` | `10` | About 1 s on 4663 |
| `ORRERY_RELAYER_KEY[_FILE]`, `ORRERY_CHECK_SIGNER_KEY[_FILE]`, `ORRERY_ATTESTER_KEY[_FILE]` | anvil keys on 31337 only | Required on any other chain: a key file (JSON `{ "privateKey": ... }` or raw hex) |
| `ORRERY_IPFS_GATEWAY` | `https://ipfs.io/ipfs/` | |
| `ORRERY_PROBE_FRESH_SECONDS` | `600` | A paid check reprobes when the cached probe is older |
| `ORRERY_PUBLIC_RATE_PER_MINUTE` | `60` | Public read endpoints, per IP |
| `ORRERY_TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Peers allowed to set X-Forwarded-For; a public peer is never trusted. `off` disables |
| `ORRERY_CORS_ORIGINS` | the local web origins | Comma list of web origins the API answers |
| `ORRERY_INDEXER_START_BLOCK`, `ORRERY_INDEXER_MAX_LAG`, `ORRERY_INDEXER_HEALTH_PORT` | `0`, `600`, `8788` | Health is lag against the chain head |

Web variables: `NEXT_PUBLIC_CHAIN_ID` (default 4663), `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_MODULE`,
`NEXT_PUBLIC_ATTESTOR`, `NEXT_PUBLIC_LENS`, `NEXT_PUBLIC_REGISTRY`, `NEXT_PUBLIC_USDG`, `NEXT_PUBLIC_SITE_URL`,
`NEXT_PUBLIC_X_HANDLE`.
