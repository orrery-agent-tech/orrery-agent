// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6).
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { bytesToHex, type Hex } from "viem";

export interface ProofResult {
  proof: Hex;
  publicInputs: bigint[];
  millis: number;
}

/**
 * Proves the transact circuit with UltraHonk for the EVM verifier. Proving runs where this is
 * called: in the browser for users, in Node for tests and fixtures.
 */
export class TransactProver {
  private constructor(
    private readonly noir: Noir,
    private readonly backend: UltraHonkBackend,
    private readonly api: Barretenberg,
  ) {}

  static async create(circuit: CompiledCircuit, threads?: number): Promise<TransactProver> {
    const api = await Barretenberg.new(threads ? { threads } : {});
    return new TransactProver(new Noir(circuit), new UltraHonkBackend(circuit.bytecode, api), api);
  }

  async prove(inputs: Record<string, unknown>): Promise<ProofResult> {
    const started = Date.now();
    const { witness } = await this.noir.execute(inputs as InputMap);
    const { proof, publicInputs } = await this.backend.generateProof(witness, { verifierTarget: "evm" });
    return {
      proof: bytesToHex(proof),
      publicInputs: publicInputs.map((p) => BigInt(p)),
      millis: Date.now() - started,
    };
  }

  async destroy(): Promise<void> {
    await this.api.destroy();
  }
}
