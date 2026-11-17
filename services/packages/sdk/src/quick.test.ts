import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ORRERY_MAINNET, agentFromEnv } from "./quick";

describe("agentFromEnv", () => {
  const key = generatePrivateKey();

  it("defaults to Robinhood Chain and asks for the module until a deployment is recorded", () => {
    if (!ORRERY_MAINNET.module) {
      expect(() => agentFromEnv({ ORRERY_SIGNER_KEY: key })).toThrow(/ORRERY_MODULE/);
    }
    const agent = agentFromEnv({ ORRERY_SIGNER_KEY: key, ORRERY_MODULE: ORRERY_MAINNET.module ?? "0x2b4f4b391ed19c26587fc7c83fbf7646ba24ce72" });
    expect(agent.signer).toBe(privateKeyToAccount(key).address);
    expect(agent.publicClient.chain?.id).toBe(4663);
    // the default must be an endpoint that publishes transactions: the agent sends its own top-ups
    expect(ORRERY_MAINNET.rpcUrl).not.toContain("blockmachine");
    expect((agent.wallet.transport as { url?: string }).url).toBe(ORRERY_MAINNET.rpcUrl);
    expect(agent.wallet.chain?.rpcUrls.default.http).toEqual([ORRERY_MAINNET.rpcUrl]);
  });

  it("takes the chain, RPC and module from the key file on another network", () => {
    const agent = agentFromEnv({ ORRERY_SIGNER_KEY: key, ORRERY_CHAIN_ID: "46630", ORRERY_RPC_URL: "http://127.0.0.1:8545", ORRERY_MODULE: "0x2b4f4b391ed19c26587fc7c83fbf7646ba24ce72" });
    expect(agent.publicClient.chain?.id).toBe(46630);
    expect((agent.wallet.transport as { url?: string }).url).toBe("http://127.0.0.1:8545");
    expect(agent.module).toBe("0x2B4F4B391eD19C26587fC7c83fbf7646BA24CE72");
  });

  it("says what is missing in plain words", () => {
    expect(() => agentFromEnv({})).toThrow(/ORRERY_SIGNER_KEY/);
    expect(() => agentFromEnv({ ORRERY_SIGNER_KEY: "0x12" })).toThrow(/ORRERY_SIGNER_KEY/);
    // no default module away from 4663: a wrong one would top up from nowhere
    expect(() => agentFromEnv({ ORRERY_SIGNER_KEY: key, ORRERY_CHAIN_ID: "46630" })).toThrow(/ORRERY_MODULE/);
    expect(() => agentFromEnv({ ORRERY_SIGNER_KEY: key, ORRERY_CHAIN_ID: "abc" })).toThrow(/ORRERY_CHAIN_ID/);
  });
});
