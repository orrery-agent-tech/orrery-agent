"use client";

import { useCallback, useState } from "react";
import { getAddress, isAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import { usePublicClient, useReadContract, useSignTypedData } from "wagmi";
import { iOrreryShieldAbi } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { useTx, useWallet } from "@/lib/orry/chain";
import { ORRY } from "@/lib/orry/config";
import { parseAmount } from "@/lib/orry/format";
import { usdg } from "@/lib/markets/math";
import { CHAIN_ID, USDG_DECIMALS } from "@/lib/config";
import { getProver, loadShieldEvents } from "@/lib/r2/shield/client";
import {
  ShieldedWallet,
  accountKeyTypedData,
  deriveAccountKeys,
  encryptNote,
  exitWithdrawal,
  ownerHash,
  prepareTransact,
  randomField,
  secretCommit,
  type AccountKeys,
} from "@/lib/r2/shield";
import { AmountField, Fig, NoticeLine, OrryHead, Row, Segmented } from "../orry/parts";

const POOL = ORRY.shield as Address;
const poolAbi = iOrreryShieldAbi as Abi;
const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
type Mode = "deposit" | "send" | "withdraw";

/** The shield desk. `exitOnly` (Shield held): the private balance and the withdrawal stay, deposits and sends wait. */
export function ShieldView({ exitOnly = false }: { exitOnly?: boolean }) {
  const { address, ready } = useWallet();
  const pub = usePublicClient();
  const sign = useSignTypedData();
  const tx = useTx();
  const [keys, setKeys] = useState<AccountKeys | null>(null);
  const [wallet, setWallet] = useState<ShieldedWallet | null>(null);
  const [mode, setMode] = useState<Mode>(exitOnly ? "withdraw" : "deposit");
  const [amt, setAmt] = useState("");
  const [to, setTo] = useState("");
  const asset = useReadContract({ address: POOL, abi: poolAbi, functionName: "asset", query: { staleTime: Infinity } }).data as Address | undefined;
  const depositBps = Number(useReadContract({ address: POOL, abi: poolAbi, functionName: "depositFeeBps", query: { staleTime: Infinity } }).data ?? 0);
  const withdrawBps = Number(useReadContract({ address: POOL, abi: poolAbi, functionName: "withdrawFeeBps", query: { staleTime: Infinity } }).data ?? 0);
  const leaves = useReadContract({ address: POOL, abi: poolAbi, functionName: "nextLeafIndex", query: { refetchInterval: 15_000 } }).data;
  const account = useReadContract({ address: POOL, abi: poolAbi, functionName: "accountOf", args: address ? [address] : undefined, query: { enabled: Boolean(address) } });
  const registered = Boolean(account.data && (account.data as readonly [bigint, Hex])[0] !== 0n);
  const wallBal = useReadContract({ address: asset, abi: erc20, functionName: "balanceOf", args: address ? [address] : undefined, query: { enabled: Boolean(asset && address) } }).data as bigint | undefined;

  /** Rebuilds the notes from the pool's events, checks the root on chain and drops spent notes. */
  const sync = useCallback(
    async (k: AccountKeys) => {
      if (!address || !pub) return null;
      const w = new ShieldedWallet(getAddress(address), k);
      w.apply(await loadShieldEvents());
      const known = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "knownRoots", args: [w.tree.root()] });
      if (!known) throw new Error("Your notes are still syncing with the chain. Open it again in a few seconds.");
      await w.checkSpent((n) => pub.readContract({ address: POOL, abi: poolAbi, functionName: "nullifierSpent", args: [n] }) as Promise<boolean>);
      setWallet(w);
      return w;
    },
    [address, pub],
  );

  async function open() {
    await tx.run("Open Shield", async ({ send, step }) => {
      step("Sign one message in your wallet to unlock your Shield keys. It moves no funds.");
      const k = deriveAccountKeys(await sign.mutateAsync(accountKeyTypedData(CHAIN_ID)));
      if (!registered) {
        step("Approve the Shield account registration in your wallet.");
        await send({ address: POOL, abi: poolAbi, functionName: "register", args: [k.npk, k.viewKey] });
        await account.refetch();
      }
      setKeys(k);
      step("Syncing your notes from the chain.");
      await sync(k);
      return "Shield unlocked. Your private balance is in view.";
    });
  }

  async function deposit() {
    const a = parseAmount(amt, USDG_DECIMALS);
    if (!address || !keys || !a || !asset) return;
    await tx.run("Deposit", async ({ send, step }) => {
      const fee = (await pub!.readContract({ address: POOL, abi: poolAbi, functionName: "depositFee", args: [address, a] })) as bigint;
      const note = { asset: BigInt(asset), amount: a - fee, blinding: randomField(), ownerHash: ownerHash(getAddress(address), keys.npk) };
      step("Approve the USDG spend for Shield in your wallet.");
      await send({ address: asset, abi: erc20 as Abi, functionName: "approve", args: [POOL, a] });
      step("Sign the deposit transaction in your wallet.");
      await send({ address: POOL, abi: poolAbi, functionName: "deposit", args: [a, secretCommit(note), encryptNote(keys.viewKey, note)] });
      setAmt("");
      await new Promise((r) => setTimeout(r, 4000));
      await sync(keys);
      return `Your private balance grew by ${usdg(a - fee)} USDG.`;
    });
  }

  async function move(kind: "send" | "withdraw", all = false) {
    const target = (to || (kind === "withdraw" ? address : "")) as string;
    if (!address || !keys || !wallet || !asset || !pub || !isAddress(target)) return;
    await tx.run(kind === "send" ? "Send" : "Withdraw", async ({ send, step }) => {
      let recipient: { npk: bigint; viewKey: Hex } | undefined;
      if (kind === "send") {
        const [npk, viewKey] = (await pub.readContract({ address: POOL, abi: poolAbi, functionName: "accountOf", args: [target] })) as readonly [bigint, Hex];
        if (npk === 0n) throw new Error("No Shield account is registered for that address.");
        recipient = { npk, viewKey };
      }
      const exit = all ? exitWithdrawal(wallet.balance(), 0n, withdrawBps) : undefined;
      const amount = exit?.amount ?? parseAmount(amt, USDG_DECIMALS);
      if (!amount) throw new Error("Add an amount to continue.");
      const floor = kind === "withdraw" ? ((await pub.readContract({ address: POOL, abi: poolAbi, functionName: "withdrawFeeFloor", args: [target, amount] })) as bigint) : undefined;
      const prepared = prepareTransact({
        chainId: CHAIN_ID,
        pool: POOL,
        owner: getAddress(address),
        keys,
        kind,
        asset,
        amount,
        protocolFee: exit?.protocolFee,
        protocolFeeFloor: floor,
        omitEmptyOutputs: all ? true : undefined,
        to: getAddress(target),
        recipient,
        fee: 0n,
        notes: wallet.notes(),
        tree: wallet.tree,
        relayer: getAddress(address),
      });
      step("Sign this move in your wallet.");
      const signature = await sign.mutateAsync(prepared.typedData as never);
      step("Building the proof in this browser tab. It needs a little time.");
      const prover = await getProver();
      const { proof } = await prover.prove(await prepared.witness(signature));
      step("Send the transaction from your wallet.");
      const held = wallet.hold(prepared.spent);
      try {
        await send({ address: POOL, abi: poolAbi, functionName: "transact", args: [{ ...prepared.args, proof }, prepared.ext] });
      } catch (e) {
        wallet.release(held);
        throw e;
      }
      setAmt("");
      await new Promise((r) => setTimeout(r, 4000));
      await sync(keys);
      return kind === "send" ? `${usdg(amount)} USDG sent privately.` : `${usdg(amount)} USDG left Shield for ${target.slice(0, 6)}…${target.slice(-4)}.`;
    });
  }

  const balance = wallet?.balance();
  return (
    <>
      {exitOnly ? null : (
        <OrryHead
          title="A USDG balance only you can see."
          lead={<p>Put USDG into a private balance, pass it to another Shield account, or take it out to any address. Every move is a zero-knowledge proof built in your browser and signed by your wallet.</p>}
          reading={
            <div className="rc-card">
              <p className="rc-card-title">Shield</p>
              <p className="rc-big">
                <Fig v={leaves !== undefined ? Number(leaves).toLocaleString("en-US") : undefined} unit="notes" />
              </p>
              <dl className="rc-rows">
                <Row label="Deposit fee">{depositBps ? `${depositBps / 100}%` : "…"}</Row>
                <Row label="Withdrawal fee">{withdrawBps ? `${withdrawBps / 100}%` : "…"}</Row>
              </dl>
            </div>
          }
        />
      )}
      <div className="rc-grid">
        <section className="rc-desk r2-desk" aria-label="Shield">
          {!ready ? (
            <WalletButton />
          ) : !keys ? (
            <div className="rc-desk-body">
              <p className="rc-muted">{registered ? "One signature unlocks your Shield and shows your private balance." : "One signature makes your Shield keys, and one transaction registers them."}</p>
              <button className="primary rc-go" type="button" disabled={Boolean(tx.busy)} onClick={() => void open()}>
                {tx.busy ? "Unlocking…" : "Unlock my Shield"}
              </button>
            </div>
          ) : (
            <>
              <p className="r2-quote">
                Private balance <b className="mono">{balance !== undefined ? usdg(balance) : "…"}</b> USDG
              </p>
              <Segmented
                label="Shield actions"
                value={mode}
                onChange={setMode}
                options={[...(exitOnly ? [] : [{ id: "deposit" as Mode, label: "Deposit" }, { id: "send" as Mode, label: "Send" }]), { id: "withdraw", label: "Withdraw" }]}
              />
              <div className="rc-desk-body">
                {mode === "deposit" ? (
                  <AmountField id="shield-in" label="Deposit amount, USDG" unit="USDG" value={amt} onChange={setAmt} hint={wallBal !== undefined ? `Wallet balance: ${usdg(wallBal)} USDG` : undefined} />
                ) : (
                  <>
                    <label className="r2-field">
                      <span>{mode === "send" ? "Shield account" : "To address"}</span>
                      <input value={to} placeholder={mode === "withdraw" ? address : "0x…"} onChange={(e) => setTo(e.target.value.trim())} spellCheck={false} />
                    </label>
                    <AmountField id="shield-amt" label="USDG" unit="USDG" value={amt} onChange={setAmt} />
                  </>
                )}
                <button className="primary rc-go" type="button" disabled={Boolean(tx.busy) || !parseAmount(amt, USDG_DECIMALS)} onClick={() => void (mode === "deposit" ? deposit() : move(mode))}>
                  {tx.busy ? "Working…" : mode === "deposit" ? "Deposit" : mode === "send" ? "Send privately" : "Withdraw"}
                </button>
                {mode === "withdraw" && balance && wallet && wallet.notes().length <= 2 ? (
                  <button className="secondary" type="button" disabled={Boolean(tx.busy)} onClick={() => void move("withdraw", true)}>
                    Withdraw everything
                  </button>
                ) : null}
              </div>
            </>
          )}
          <NoticeLine notice={tx.notice} />
        </section>
      </div>
    </>
  );
}
