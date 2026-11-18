import { getAddress, type Address, type Hex } from "viem";
import { iSealedBatchMarketAbi } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { revertName, sendSimulated } from "./keeper.js";

/**
 * Opt-in reveal relay (`docs/ORRY-R1-SPEC.md` section 5): sends `revealFor(account, order, salt)` for every order a
 * trader queued through `POST /v1/markets/relay/reveals`, once the batch's reveal window is open and before it closes.
 * Each reveal is simulated first. Gas from its own key role (`ORRERY_RELAY_KEY`). Spend is bounded by the commitments:
 * at most one reveal per committed order, and every commitment is a transaction the trader paid for.
 */

export interface RelayStep {
  market: Address;
  batch: string;
  account: Address;
  status: "sent" | "revealed" | "failed" | "waiting";
  reason?: string;
  txHash?: Hex;
}

interface Row {
  market: string;
  batch: string;
  account: string;
  sell_asset: boolean;
  amount_in: string;
  limit_price: string;
  mode: number;
  pay_fee_in_orry: boolean;
  salt: string;
  reveal_end0: string;
  period: string;
  reveal_seconds: number;
  revealed: boolean | null;
  reveal_tx: string | null;
}

/** Revert names after which the same reveal cannot succeed later in the window. */
const FINAL = new Set(["BadReveal", "BelowMinimum", "ZeroAmount"]);

export class MarketRelay {
  constructor(
    private readonly cfg: Config,
    private readonly chain: Chain,
    private readonly sql: Sql,
    private readonly key: Hex,
  ) {
    if (!cfg.markets) throw new Error("ORRERY_MARKET_FACTORY is not configured");
  }

  private async queued(): Promise<Row[]> {
    return this.sql<Row[]>`select r.market, r.batch::text, r.account, r.sell_asset, r.amount_in::text, r.limit_price::text, r.mode,
        r.pay_fee_in_orry, r.salt, m.reveal_end0::text, m.period::text, m.reveal_seconds, o.revealed, o.reveal_tx
      from market_relay r join markets m on m.market = r.market
      left join market_orders o on o.market = r.market and o.batch = r.batch and o.account = r.account
      where r.status = 'queued' order by r.batch, r.created_at`;
  }

  private async mark(r: Row, status: "sent" | "revealed" | "failed", tx: string | null, reason: string | null) {
    await this.sql`update market_relay set status = ${status}, tx = ${tx}, reason = ${reason}, updated_at = now()
      where market = ${r.market} and batch = ${r.batch}::numeric and account = ${r.account} and status = 'queued'`;
  }

  /** Seconds until the next queued order's reveal window opens (0: one is open now; 60 when nothing is queued). */
  async secondsUntilNext(now: bigint): Promise<bigint> {
    let best: bigint | null = null;
    for (const r of await this.queued()) {
      const revealEnd = BigInt(r.reveal_end0) + BigInt(r.batch) * BigInt(r.period);
      const opens = revealEnd - BigInt(r.reveal_seconds);
      const wait = opens > now ? opens - now : 0n;
      if (best === null || wait < best) best = wait;
    }
    return best ?? 60n;
  }

  /** One pass over the queue at the latest block time. */
  async passOnce(opts: { dryRun?: boolean } = {}): Promise<{ now: bigint; steps: RelayStep[] }> {
    const now = (await this.chain.public.getBlock()).timestamp;
    const steps: RelayStep[] = [];
    const wallet = this.chain.wallet(this.key);
    for (const r of await this.queued()) {
      const revealEnd = BigInt(r.reveal_end0) + BigInt(r.batch) * BigInt(r.period);
      const opens = revealEnd - BigInt(r.reveal_seconds);
      const base = { market: getAddress(r.market), batch: r.batch, account: getAddress(r.account) };
      if (r.revealed) {
        // revealed by another transaction (the wallet itself, most often), as the indexer saw it
        await this.mark(r, "revealed", r.reveal_tx, null);
        steps.push({ ...base, status: "revealed", txHash: (r.reveal_tx as Hex | null) ?? undefined });
        continue;
      }
      if (now < opens) continue;
      if (now >= revealEnd) {
        await this.mark(r, "failed", null, "The reveal window closed before the order could be revealed.");
        steps.push({ ...base, status: "failed", reason: "window closed" });
        continue;
      }
      const order = {
        sellAsset: r.sell_asset,
        amountIn: BigInt(r.amount_in),
        limitPrice: BigInt(r.limit_price),
        mode: r.mode,
        payFeeInOrry: r.pay_fee_in_orry,
      };
      let request;
      try {
        ({ request } = await this.chain.public.simulateContract({
          address: base.market,
          abi: iSealedBatchMarketAbi,
          functionName: "revealFor",
          args: [base.account, order as never, r.salt as Hex],
          account: wallet.account,
        }));
      } catch (e) {
        const reason = revertName(e);
        if (FINAL.has(reason)) {
          await this.mark(r, "failed", null, `The market refused the reveal (${reason}).`);
          steps.push({ ...base, status: "failed", reason });
        } else {
          steps.push({ ...base, status: "waiting", reason }); // retried at the next pass while the window is open
        }
        continue;
      }
      if (opts.dryRun) {
        steps.push({ ...base, status: "waiting", reason: "dry run" });
        continue;
      }
      try {
        const hash = await sendSimulated(this.chain, this.key, request as never);
        const receipt = await this.chain.public.waitForTransactionReceipt({ hash, timeout: this.cfg.receiptTimeoutMs });
        if (receipt.status === "success") {
          await this.mark(r, "sent", hash, null);
          steps.push({ ...base, status: "sent", txHash: hash });
        } else {
          steps.push({ ...base, status: "waiting", reason: "reverted on chain", txHash: hash });
        }
      } catch (e) {
        steps.push({ ...base, status: "waiting", reason: revertName(e) });
      }
    }
    return { now, steps };
  }
}
