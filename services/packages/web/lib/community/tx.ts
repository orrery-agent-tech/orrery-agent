"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BaseError, ContractFunctionRevertedError, erc20Abi, parseAbi, type Abi, type Address, type Hex } from "viem";
import { useConnection, usePublicClient, useWriteContract } from "wagmi";
import { big } from "../orry/api";
import { explain, type Notice } from "../orry/chain";
import { span, utc } from "../orry/format";
import { usd } from "./logic";

/**
 * Writes from the connected wallet to the community contracts. Same flow as the ORRY pages (simulate, send, wait for the
 * receipt, refresh every read), with the ORRY address taken from the community config and plain messages for the
 * community contracts' errors.
 */

/** Custom errors of the community contracts, so a revert decodes to its name. */
export const communityErrorsAbi = parseAbi([
  "error ZeroAddress()",
  "error PriceNotReady()",
  "error PriceAboveMax(uint256 orryNeeded, uint256 maxOrry)",
  "error InexactTransfer()",
  "error UnknownRoom()",
  "error BelowRoomStake(uint256 stakeUsd, uint256 minStakeUsd)",
  "error BadText()",
  "error UnknownMessage()",
  "error SelfTip()",
  "error ZeroAmount()",
  "error BelowReportStake()",
  "error AlreadyReported()",
  "error BadName()",
  "error NameTaken()",
  "error SameName()",
  "error BadKind()",
  "error BadDays()",
  "error BadCount()",
  "error BadPrice()",
  "error UnknownTemplate()",
  "error NotCreator()",
  "error NotListed()",
  "error AlreadyLicensed()",
  "error OwnTemplate()",
  "error SelfReferral()",
  "error AlreadyLinked()",
  "error BadStatus()",
  "error NotPayableYet(uint64 payableAt)",
  "error NothingToClaim()",
  "error WrongKind()",
  "error PastDeadline()",
  "error AlreadyClaimed()",
  "error Full()",
  "error ConditionNotMet()",
  "error SubjectAlreadyClaimed(address by)",
  "error NotClaimableYet(uint64 claimableAt)",
  "error NotOpen()",
  "error PeriodIsClosed()",
  "error NotOpenable(uint256 openableAt)",
  "error AlreadyOpened()",
]);

/** A contract ABI with the community errors added, for writes. */
export const withErrors = (abi: Abi): Abi => [...abi, ...communityErrorsAbi];

const until = (t: unknown) => Number(t ?? 0) - Math.floor(Date.now() / 1000);

const ERRORS: Record<string, (a: readonly unknown[]) => string> = {
  ZeroAddress: () => "A wallet address is required.",
  PriceNotReady: () => "The ORRY price reading is still settling. Send it again shortly.",
  PriceAboveMax: () => "The ORRY price changed after the quote was taken. Send again at the current price.",
  InexactTransfer: () => "The ORRY received differs from the amount sent.",
  UnknownRoom: () => "No room exists under that id.",
  BelowRoomStake: (a) => `Entry needs ${usd(big(a[1]))} or more earning in Stake. This wallet has ${usd(big(a[0]))}.`,
  BadText: () => "Messages must have text and fit the room's length.",
  UnknownMessage: () => "No message exists under that id.",
  SelfTip: () => "Your own messages cannot take a tip.",
  ZeroAmount: () => "Amount must be greater than zero.",
  BelowReportStake: () => "A report needs a larger ORRY balance earning in Stake.",
  AlreadyReported: () => "This message already carries your report.",
  BadName: () => "Names are 3 to 20 characters long, using a to z, 0 to 9 or underscore.",
  NameTaken: () => "Another wallet holds that name.",
  SameName: () => "This wallet already uses that name.",
  BadDays: () => "A boost runs 1 to 30 days per purchase.",
  BadCount: () => "Each purchase covers 1 to 52 passes.",
  BadPrice: () => "The price sits outside the bounds this market accepts.",
  UnknownTemplate: () => "No template exists under that id.",
  NotCreator: () => "Changes to a template come from its creator's wallet.",
  NotListed: () => "This template is off the shelf at the moment.",
  AlreadyLicensed: () => "A licence for this template is already in this wallet.",
  OwnTemplate: () => "You created this template, so it is already yours to use.",
  SelfReferral: () => "Referral links work for other wallets, not the one that made them.",
  AlreadyLinked: () => "A referrer is already on record for this wallet.",
  BadStatus: () => "No prize is attached to this event.",
  NotPayableYet: (a) => (until(a[0]) > 0 ? `The prize opens for claiming in ${span(until(a[0]))}.` : "The prize opens for claiming shortly."),
  NothingToClaim: () => "No balance is waiting here.",
  WrongKind: () => "This achievement has its own claim path.",
  PastDeadline: () => "The window for this achievement is over.",
  AlreadyClaimed: () => "A claim from this wallet is already on record.",
  Full: () => "All rewards for this achievement have gone out.",
  ConditionNotMet: () => "The condition for this wallet is not met yet.",
  SubjectAlreadyClaimed: () => "This agent's reward is already claimed.",
  NotClaimableYet: (a) => (until(a[0]) > 0 ? `Opens for claiming in ${span(until(a[0]))}.` : "Opens for claiming shortly."),
  NotOpen: () => "Claims for this month begin shortly.",
  PeriodIsClosed: () => "Claims for this month are closed.",
  NotOpenable: (a) => `Claims for this month begin on ${utc(Number(a[0] ?? 0))}.`,
  AlreadyOpened: () => "Claims for this month are already running.",
};

function explainCommunity(e: unknown, fallback: string): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    const f = name ? ERRORS[name] : undefined;
    if (f && reverted instanceof ContractFunctionRevertedError) return f(reverted.data?.args ?? []);
  }
  return explain(e, fallback);
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface TxSteps {
  send: (c: Call) => Promise<Hex>;
  step: (t: string) => void;
  /** Approves `amount` of ORRY to `spender` unless the allowance already covers it. */
  approve: (token: Address, spender: Address, amount: bigint) => Promise<void>;
}
export type Run = (label: string, fn: (h: TxSteps) => Promise<string | void>) => Promise<boolean>;

export function useCommunityTx() {
  const pub = usePublicClient();
  const qc = useQueryClient();
  const { address: account } = useConnection();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function send(c: Call): Promise<Hex> {
    if (!pub) throw new Error("The network is out of reach. Check the connection and send again.");
    const call = { ...c, abi: withErrors(c.abi) };
    // Simulating first surfaces the contract's own error before the wallet opens.
    await pub.simulateContract({ ...call, account } as never).catch((e) => {
      if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) throw e;
    });
    const hash = await writeContractAsync(call as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transaction was reverted on chain.");
    return hash;
  }

  const run: Run = async (label, fn) => {
    setBusy(label);
    setNotice({ tone: "", text: `${label}. Waiting for your wallet.` });
    const step = (t: string) => setNotice({ tone: "", text: t });
    const approve = async (token: Address, spender: Address, amount: bigint) => {
      if (!pub || !account) throw new Error("A connected wallet is needed for this.");
      const current = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender] });
      if (current >= amount) return;
      step("Your wallet asks you to approve ORRY first.");
      await send({ address: token, abi: erc20Abi as Abi, functionName: "approve", args: [spender, amount] });
    };
    try {
      const done = await fn({ send, step, approve });
      setNotice({ tone: "ok", text: done || `${label} is on record.` });
      await qc.invalidateQueries();
      return true;
    } catch (e) {
      setNotice({ tone: "error", text: explainCommunity(e, `${label} was not completed.`) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { run, busy, notice, setNotice };
}
