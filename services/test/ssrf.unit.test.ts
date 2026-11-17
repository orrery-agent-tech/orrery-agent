import { describe, expect, it } from "vitest";
import { isPublicAddress } from "@orrery/server";

describe("isPublicAddress (V5)", () => {
  it.each([
    ["8.8.8.8", true], ["1.1.1.1", true], ["2606:4700:4700::1111", true],
    ["127.0.0.1", false], ["10.1.2.3", false], ["172.16.0.1", false], ["192.168.1.1", false], ["169.254.169.254", false],
    ["100.64.0.1", false], ["0.0.0.0", false], ["224.0.0.1", false], ["::1", false], ["::", false], ["fc00::1", false],
    ["fd12::1", false], ["fe80::1", false], ["::ffff:127.0.0.1", false], ["::ffff:8.8.8.8", true], ["::ffff:7f00:1", false],
    ["64:ff9b::7f00:1", false], ["not-an-ip", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});
