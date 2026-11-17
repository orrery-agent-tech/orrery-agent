"use client";

import { useState } from "react";
import { erc20Abi, formatEther, parseEther, parseUnits, type Address } from "viem";
import { useBalance, usePublicClient, useReadContract, useSendTransaction, useWriteContract } from "wagmi";
import { ADDRESSES } from "@/lib/config";
import { short, usdg } from "@/lib/format";

/**
 * What an open session still needs before the agent can pay: USDG in the account it draws from, and a first amount of
 * ETH on the signer for its own transactions. Both are plain transfers from the connected wallet.
 */
export function Funding({
  account,
  signer,
  suggestedUsdg,
  disabled,
  run,
}: {
  account: Address;
  signer: Address;
  /** Prefill for the USDG amount: the session's daily cap. */
  suggestedUsdg: string;
  disabled: boolean;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const pub = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const [usdgIn, setUsdgIn] = useState(suggestedUsdg);
  const [ethIn, setEthIn] = useState("0.0002");
  const accountUsdg = useReadContract({ address: ADDRESSES.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account], query: { enabled: Boolean(ADDRESSES.usdg), refetchInterval: 12_000 } });
  const signerEth = useBalance({ address: signer, query: { refetchInterval: 12_000 } });

  const usdgAmount = (() => {
    try {
      const v = parseUnits(usdgIn || "0", 6);
      return v > 0n ? v : undefined;
    } catch {
      return undefined;
    }
  })();
  const ethAmount = (() => {
    try {
      const v = parseEther(ethIn || "0");
      return v > 0n ? v : undefined;
    } catch {
      return undefined;
    }
  })();

  async function addUsdg() {
    if (!pub || !ADDRESSES.usdg || !usdgAmount) return;
    const hash = await writeContractAsync({ address: ADDRESSES.usdg, abi: erc20Abi, functionName: "transfer", args: [account, usdgAmount] });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The chain reverted the transfer.");
    void accountUsdg.refetch();
  }
  async function sendGas() {
    if (!pub || !ethAmount) return;
    const hash = await sendTransactionAsync({ to: signer, value: ethAmount });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The chain reverted the transfer.");
    void signerEth.refetch();
  }

  return (
    <div className="editor-section">
      <div className="row-heading"><h3>Funds for the agent</h3></div>
      <p style={{ marginTop: 8 }}>Payments come out of the account's USDG, always within the caps. The signer spends its own ETH on gas.</p>
      <div className="fund-rows">
        <div className="fund-row">
          <div>
            <strong>Account {short(account)}</strong>
            <span className="mono">{accountUsdg.data === undefined ? "…" : `${usdg(accountUsdg.data)} USDG`}</span>
          </div>
          <label>Amount<input type="number" min="0" step="0.01" value={usdgIn} onChange={(e) => setUsdgIn(e.target.value)} /><small>USDG</small></label>
          <button className="secondary" type="button" disabled={disabled || !usdgAmount} onClick={() => void run("Add USDG", addUsdg)}>Add USDG</button>
        </div>
        <div className="fund-row">
          <div>
            <strong>Signer {short(signer)}</strong>
            <span className="mono">{signerEth.data === undefined ? "…" : `${Number(formatEther(signerEth.data.value)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`}</span>
          </div>
          <label>Amount<input type="number" min="0" step="0.0001" value={ethIn} onChange={(e) => setEthIn(e.target.value)} /><small>ETH</small></label>
          <button className="secondary" type="button" disabled={disabled || !ethAmount} onClick={() => void run("Send gas", sendGas)}>Send ETH</button>
        </div>
      </div>
    </div>
  );
}
