# Orrery

Every agent payment on a visible orbit. Orrery gives an AI agent a smart account with public spending caps (per payment,
per day and on its float), allowed calls and scoped session keys, on top of ERC-8004 identity and x402 payments. Anyone
an agent pays can take a reading of the payer and get it back signed.

Live on Robinhood Chain (chain id 4663): web at https://orreryagent.com, API at https://api.orreryagent.com, X
[@Orreryagent](https://x.com/Orreryagent). SDK on npm as `@orrery-tech/sdk`, MCP server as `@orrery-tech/mcp`.

## Contracts on Robinhood Chain

| Contract | Address |
| :--- | :--- |
| OrreryPolicyModule | [`0x2B4F4B391eD19C26587fC7c83fbf7646BA24CE72`](https://robinhoodchain.blockscout.com/address/0x2B4F4B391eD19C26587fC7c83fbf7646BA24CE72) |
| OrreryAttestor | [`0x6f192242029d779d676246C773AdbA47F7c3a0d7`](https://robinhoodchain.blockscout.com/address/0x6f192242029d779d676246C773AdbA47F7c3a0d7) |
| OrreryLens | [`0xe576C399A01beA52816889585c6693b674E174D2`](https://robinhoodchain.blockscout.com/address/0xe576C399A01beA52816889585c6693b674E174D2) |
| OrreryTreasury | [`0xa108f36699b4A42DD0230406561f9AC6796E6f21`](https://robinhoodchain.blockscout.com/address/0xa108f36699b4A42DD0230406561f9AC6796E6f21) |

Every contract above has verified source on Blockscout.

## Repository

| Folder | What |
| :--- | :--- |
| `contracts/` | Solidity (Foundry): the policy module, attestor, lens and treasury with their unit, fuzz, invariant and fork tests |
| `services/packages/server` | API (credit packs over x402, signed checks, data), indexer and prober |
| `services/packages/web` | The web app (Next.js) |
| `services/packages/sdk` | TypeScript SDK for agents and merchants |
| `services/packages/mcp` | MCP server |
| `services/packages/shared` | Types and constants shared by the packages |

## Build and test

```bash
cd contracts && forge build && forge test --no-match-path '*/fork/*'
cd services && pnpm install && pnpm test
cd services/packages/web && pnpm build
```
