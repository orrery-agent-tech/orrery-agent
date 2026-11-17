import { describe, expect, it } from "vitest";
import { canCheck, checkCost, loadConfig, utcDay, utcMonth, type CheckAccount } from "@orrery/server";

const base = {
  ORRERY_CHAIN_ID: "31337",
  ORRERY_MODULE: "0x0000000000000000000000000000000000000001",
  ORRERY_ATTESTOR: "0x0000000000000000000000000000000000000002",
  ORRERY_LENS: "0x0000000000000000000000000000000000000003",
  ORRERY_REGISTRY: "0x0000000000000000000000000000000000000004",
  ORRERY_USDG: "0x0000000000000000000000000000000000000005",
  ORRERY_TREASURY: "0x0000000000000000000000000000000000000006",
};

describe("check pricing (R-58)", () => {
  const p = loadConfig(base).pricing;

  it("defaults: 1,000 free a month, 2 credits a check (0.004 USDG), 1 past 100,000 a month, plan 99 USDG for 30 days", () => {
    expect(p).toMatchObject({
      freeChecksPerMonth: 1000,
      creditsPerCheck: 2,
      volumeCreditsPerCheck: 1,
      volumeChecks: 100_000,
      planPrice: 99_000_000n,
      planCredits: 49_500,
      planDays: 30,
      checksPerMinute: 120,
      planChecksPerMinute: 1200,
    });
    const cfg = loadConfig(base);
    // one credit is packPrice / packSize = 0.002 USDG, so a check is 0.004 and a volume check 0.002
    expect((cfg.packPrice * BigInt(p.creditsPerCheck)) / BigInt(cfg.packSize)).toBe(4_000n);
    expect((cfg.packPrice * BigInt(p.volumeCreditsPerCheck)) / BigInt(cfg.packSize)).toBe(2_000n);
    // the plan's credits are its price at the pack rate
    expect(BigInt(p.planCredits) * cfg.packPrice).toBe(p.planPrice * BigInt(cfg.packSize));
  });

  it("the volume rate starts with check 100,001 of the month, or at once with a plan", () => {
    expect(checkCost(p, 0, false)).toBe(2);
    expect(checkCost(p, 99_999, false)).toBe(2);
    expect(checkCost(p, 100_000, false)).toBe(1);
    expect(checkCost(p, 0, true)).toBe(1);
  });

  it("a check can be paid with free checks left or enough credits", () => {
    const a = (o: Partial<CheckAccount>): CheckAccount => ({ credits: 0n, planUntil: null, planActive: false, checks: 0, freeChecks: 0, freeChecksLeft: 0, checkCost: 2, ...o });
    expect(canCheck(a({ freeChecksLeft: 1 }))).toBe(true);
    expect(canCheck(a({ credits: 1n }))).toBe(false);
    expect(canCheck(a({ credits: 2n }))).toBe(true);
    expect(canCheck(a({ credits: 1n, checkCost: 1 }))).toBe(true);
  });

  it("months and days are UTC", () => {
    const d = new Date("2026-11-30T23:30:00-05:00"); // 04:30 UTC on 1 December
    expect(utcMonth(d)).toBe("2026-12-01");
    expect(utcDay(d)).toBe("2026-12-01");
  });

  it("refuses a plan priced like a pack, and a volume rate above the normal one", () => {
    expect(() => loadConfig({ ...base, ORRERY_PLAN_PRICE: "1000000" })).toThrow(/must be positive and differ/);
    expect(() => loadConfig({ ...base, ORRERY_VOLUME_CREDITS_PER_CHECK: "3" })).toThrow(/must not exceed/);
  });
});
