import { describe, expect, it } from "vitest";
import { bpsOf, excerpt, percent, referrerFromSearch, usd, utf8Bytes, validName, withHeadroom } from "./logic";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("community helpers", () => {
  it("counts UTF-8 bytes like the chat contract", () => {
    expect(utf8Bytes("gm")).toBe(2);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("🚀")).toBe(4);
  });

  it("validates names like OrryNames.isValid", () => {
    expect(validName("abc")).toBe(true);
    expect(validName("a_1_b_2_c_3_d_4_e_5_")).toBe(true);
    expect(validName("ab")).toBe(false);
    expect(validName("a".repeat(21))).toBe(false);
    expect(validName("Abc")).toBe(false);
    expect(validName("a-b")).toBe(false);
  });

  it("adds 1% headroom, rounded up", () => {
    expect(withHeadroom(100n)).toBe(101n);
    expect(withHeadroom(1n)).toBe(2n);
    expect(withHeadroom(0n)).toBe(0n);
    expect(withHeadroom(10n ** 18n)).toBe(101n * 10n ** 16n);
  });

  it("splits basis points and prints percents", () => {
    expect(bpsOf(1000n, 500)).toBe(50n);
    expect(percent(500)).toBe("5%");
    expect(percent(2000)).toBe("20%");
    expect(percent(1250)).toBe("12.5%");
  });

  it("prints USDG base units as dollars", () => {
    expect(usd(10_000n)).toBe("$0.01");
    expect(usd(500_000n)).toBe("$0.50");
    expect(usd(1_250_000_000n)).toBe("$1,250.00");
    expect(usd(0n)).toBe("$0.00");
    expect(usd(9_999n)).toBe("<$0.01");
  });

  it("reads a referral link, never for the wallet itself", () => {
    expect(referrerFromSearch(`?ref=${A}`, B)).toBe(A);
    expect(referrerFromSearch(`?ref=${A}`, A.toUpperCase().replace("0X", "0x"))).toBeUndefined();
    expect(referrerFromSearch("?ref=0x0000000000000000000000000000000000000000")).toBeUndefined();
    expect(referrerFromSearch("?ref=nope")).toBeUndefined();
    expect(referrerFromSearch("")).toBeUndefined();
  });

  it("cuts long replies to one line", () => {
    expect(excerpt("a\n b")).toBe("a b");
    expect(excerpt("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
