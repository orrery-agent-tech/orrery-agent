# @orrery-tech/mcp

Orrery inside any MCP client. Take a signed reading of the agent behind a payment before you serve it, look up an
agent's policy, read signed onchain datasets, and let your own agent pay x402 endpoints from its float, inside the
orbit you set for it.

## Tools

| Tool | Cost | Purpose |
| :--- | :--- | :--- |
| `orrery_pricing` | free | Prices for checks and for Orrery Data packs |
| `orrery_signer_record`, `orrery_agent_record` | free | Public entry for a session signer or an ERC-8004 agent |
| `orrery_verify_check` | free | Confirms a signed reading: signature, active check signer, expiry |
| `orrery_check_payer`, `orrery_check_agent` | one check | Signed reading, confirmed on chain, plus remaining credits |
| `orrery_credits` | free | Credits, this month's free checks, remaining data calls |
| `orrery_data_catalog`, `orrery_data_providers` | free | Official datasets and listed third-party providers |
| `orrery_data_query` | one data call | Signed records, confirmed before they are returned |
| `orrery_data_verify` | free | Confirms a data response offline |
| `orrery_data_buy_pack` | one pack | Data calls paid in USDG, or in ORRY at 20% off |
| `orrery_allowance` | free | Remaining spend for your agent today |
| `orrery_ensure_float` | gas | Refills the signer's float inside the session caps |
| `orrery_pay_x402` | the URL's price | Pays an x402 resource from the float |

Every paid tool returns the balance that remains and adds a notice once it falls below 20% of a pack. Any payment above
`ORRERY_MCP_MAX_PAYMENT_USD` (1 USD by default) goes through only when the call includes `confirm: true`.

## Setup

```json
{
  "mcpServers": {
    "orrery": {
      "command": "npx",
      "args": ["-y", "@orrery-tech/mcp"],
      "env": {
        "ORRERY_API_KEY": "or_...",
        "ORRERY_AGENT_KEY_FILE": "/home/you/.config/orrery/agent.key"
      }
    }
  }
}
```

- `ORRERY_API_KEY`: your Orrery API key. You get one with a credit or data pack purchase, or rotate it on orreryagent.com.
- `ORRERY_API_KEY_FILE`: path where `orrery_data_buy_pack` saves a newly issued key, with mode 600.
- `ORRERY_AGENT_KEY_FILE`: the session signer key of your agent, in a file readable by you alone (`chmod 600`). A file
  with wider permissions is rejected. The agent tools use it; the counterparty tools work without it.
- `ORRERY_API_URL`, `ORRERY_RPC_URL`, `ORRERY_CHAIN_ID`, `ORRERY_ATTESTOR`, `ORRERY_MODULE`: point at Orrery on
  Robinhood Chain unless you override them.

Orrery's data signer signs every data response (EIP-712, domain "Orrery Data"). Before returning a response, the server
compares its signature with the signer published at `/v1/data/signer`.
