import { describe, expect, it } from "vitest";
import { oauth1Header, pct } from "../packages/server/src/support-x.js";

describe("X OAuth 1.0a", () => {
  it("matches X's published signature example", () => {
    const header = oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json",
      { status: "Hello Ladies + Gentlemen, a signed OAuth request!", include_entities: "true" },
      { apiKey: "xvz1evFS4wEEPTGEFPHBog", apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      "1318622958",
    );
    expect(header).toContain(`oauth_signature="${pct("hCtSmYh+iHYCEqBWrE7C7hYmtUk=")}"`);
    expect(pct("Ladies + Gentlemen!")).toBe("Ladies%20%2B%20Gentlemen%21");
  });
});
