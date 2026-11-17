# @orrery-tech/sdk

TypeScript SDK for [Orrery](https://orreryagent.com) on Robinhood Chain. An operator gives an agent's signer capped spending
authority over its smart account; the agent pays over x402 from a small float that the SDK tops up within those caps;
a merchant checks the paying address with one call and gets a signed answer it verifies on-chain.

Orrery's contract and API addresses on Robinhood Chain (4663) are built in, so most calls need no configuration.

## Install

```bash
npm install @orrery-tech/sdk viem
```

`viem` 2.x is a peer dependency. The package is ESM and runs on Node.js 20 or later.

## Agent quick start

Set up the agent in the Orrery dashboard, under [Agents](https://orreryagent.com/dashboard/agents). It creates the account, registers the agent,
opens the session with the limits you pick and saves the signer's key file (`agent.env`). Give that file to the agent
and load it as environment variables:

```bash
node --env-file=agent.env agent.js
```

```ts
// agent.js
import { agentFromEnv } from "@orrery-tech/sdk";

const agent = agentFromEnv(); // reads ORRERY_SIGNER_KEY and the rest of the key file

console.log(await agent.getAllowance()); // per token: per payment, left today, float headroom

// Pays x402 "exact" requirements from the float, topping the float up through the module first.
const res = await agent.x402Fetch("https://api.example.com/data");
console.log(res.status, await res.text());
```

Only `ORRERY_SIGNER_KEY` is required. `ORRERY_CHAIN_ID`, `ORRERY_RPC_URL` and `ORRERY_MODULE` default to Orrery on
Robinhood Chain. You can also pass the values directly: `agentFromEnv({ ORRERY_SIGNER_KEY: "0x..." })`.

The agent sends its own top-ups, so its RPC must accept transactions. The default, `ORRERY_MAINNET.rpcUrl`
(`https://robinhood-rpc.publicnode.com`), does. To use your own node, set `ORRERY_RPC_URL` in the key file or the
environment; it takes precedence over the default.

The signer needs a little ETH for gas before its first top-up; the operator sends it. After that, `agent.ensureGas(min)`
tops gas up through the module when native ETH is in the caps.

## Merchant quick start

Get an API key in the dashboard, under [Credits](https://orreryagent.com/dashboard/credits), with one wallet signature. Then check the address
that paid you:

```ts
import { checkPayment } from "@orrery-tech/sdk";

const v = await checkPayment(payer, process.env.ORRERY_API_KEY);
if (v.ok) {
  // v.result.status, v.result.caps, v.result.endpointsLive, v.result.validUntil
} else {
  console.log(v.reason);
}
```

`checkPayment` asks the check service about `payer`, then verifies the signed answer: the EIP-712 domain is bound to
this chain and the Orrery attestor, the signer is an active check signer on-chain, the answer is current and it is
about this payer. `ok` is true only when all of those hold.

To run the two steps yourself, or against another network:

```ts
import { OrreryApi, verifyCheck, ORRERY_MAINNET, robinhoodChain } from "@orrery-tech/sdk";
import { createPublicClient, http } from "viem";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http() });
const res = await new OrreryApi(ORRERY_MAINNET.apiUrl, process.env.ORRERY_API_KEY).checkPayer(payer);
const v = await verifyCheck(publicClient, ORRERY_MAINNET.attestor, res, { payer });
```

## Plain HTTP check

The same check from any language:

```bash
curl -H "authorization: Bearer $ORRERY_API_KEY" \
  https://api.orreryagent.com/v1/check/by-signer/0xPAYING_ADDRESS
```

The response holds `result` (decimal strings), `signature`, `checkSigner`, `domain` and `extras`. Pass it to
`verifyCheck` to verify it in TypeScript.

## Operator calls in code

The dashboard's Agents page does this for you. To script it, the agent creates a fresh signer and signs its consent, and the
operator sends the session from its account:

```ts
import { signSessionConsent, operatorCalls, ORRERY_MAINNET, type Policy } from "@orrery-tech/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(generatePrivateKey()); // stays with the agent
const policy: Policy = {
  caps: [{ token: USDG, perTx: 10_000_000n, perDay: 50_000_000n, floatMax: 20_000_000n }],
  targets: [],
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  increaseDelay: 3600,
};
const consent = await signSessionConsent(signer, {
  chainId: ORRERY_MAINNET.chainId,
  module: ORRERY_MAINNET.module,
  account,
  agentId,
  policy,
});
const data = operatorCalls.openSession(agentId, signer.address, policy, consent);
// send `data` to ORRERY_MAINNET.module from your account (for example through Safe execTransaction)
```

`operatorCalls` also encodes `decreasePolicy`, `proposeIncrease`, `applyIncrease`, `cancelIncrease`, `pause`,
`unpause`, `revoke` and `payVerification`.

## What the package exports

| Area | Exports |
| --- | --- |
| Operator | `operatorCalls`, `signSessionConsent`, `policyHash`, `agentWalletDigest`, `Policy`, `TokenCap`, `Target` |
| Agent | `agentFromEnv`, `AgentClient` |
| Merchant | `checkPayment`, `OrreryApi`, `verifyCheck`, `parseCheck`, `readOnChain`, `CheckResponse`, `CheckResult` |
| Network | `ORRERY_MAINNET`, `robinhoodChain`, `orreryPolicyModuleAbi`, `orreryAttestorAbi`, `orreryLensAbi` |
| x402 | `X402_VERSION`, `HEADER_REQUIRED`, `HEADER_SIGNATURE`, `HEADER_RESPONSE`, `encodeHeader`, `decodeHeader`, `PaymentRequired`, `PaymentRequirements`, `PaymentPayload` |

Full documentation: [orreryagent.com/docs](https://orreryagent.com/docs).
