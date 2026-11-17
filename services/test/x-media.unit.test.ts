import { describe, expect, it } from "vitest";
import { xMedia } from "../packages/server/src/x-media.js";

describe("X video post", () => {
  it("initializes, appends 4 MB segments, waits for processing, then posts with the media id", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    let polls = 0;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: init.body });
      expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^OAuth /);
      const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
      if (url.endsWith("/media/upload/initialize")) return ok({ id: "777" });
      if (url.includes("/append")) return ok({ expires_at: 1 });
      if (url.endsWith("/finalize")) return ok({ id: "777", processing_info: { state: "pending", check_after_secs: 1 } });
      if (url.includes("command=STATUS")) return ok({ id: "777", processing_info: { state: ++polls < 2 ? "in_progress" : "succeeded" } });
      if (url.endsWith("/tweets")) return new Response(JSON.stringify({ data: { id: "999", text: "t" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const x = xMedia({ apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "a" }, fakeFetch, async () => {});
    const id = await x.uploadVideo(new Uint8Array(13 * 1024 * 1024 + 5));
    expect(id).toBe("777");
    expect(calls.filter((c) => c.url.includes("/append"))).toHaveLength(4);
    const init = JSON.parse(String(calls[0]!.body));
    expect(init).toEqual({ media_type: "video/mp4", total_bytes: 13 * 1024 * 1024 + 5, media_category: "tweet_video" });
    expect(await x.post("hello", [id])).toBe("999");
    expect(JSON.parse(String(calls.at(-1)!.body))).toEqual({ text: "hello", media: { media_ids: ["777"] } });
    await x.post("a reply", [], { replyTo: "999" });
    expect(JSON.parse(String(calls.at(-1)!.body))).toEqual({ text: "a reply", reply: { in_reply_to_tweet_id: "999" } });
    await x.post("a quote", [], { quote: "999" });
    expect(JSON.parse(String(calls.at(-1)!.body))).toEqual({ text: "a quote", quote_tweet_id: "999" });
  });

  it("stops when X reports the video failed", async () => {
    const fakeFetch = (async (url: string) => {
      const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
      if (url.endsWith("/initialize")) return ok({ id: "1" });
      if (url.includes("/append")) return ok({});
      return ok({ id: "1", processing_info: { state: "failed" } });
    }) as unknown as typeof fetch;
    await expect(xMedia({ apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "a" }, fakeFetch, async () => {}).uploadVideo(new Uint8Array(10))).rejects.toThrow(/could not process/);
  });
});
