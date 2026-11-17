import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * X API v2 for the Orrery X account's mentions and replies, signed with OAuth 1.0a user context (one account, no token refresh).
 * Pay-per-use billing: reading the account's own mentions and posting a reply are the only calls made.
 */

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

export function loadXCredentials(file: string | undefined): XCredentials | null {
  if (!file) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<XCredentials>;
    if (!j.apiKey || !j.apiSecret || !j.accessToken || !j.accessSecret) return null;
    return { apiKey: j.apiKey, apiSecret: j.apiSecret, accessToken: j.accessToken, accessSecret: j.accessSecret };
  } catch {
    return null;
  }
}

/** RFC 3986 percent-encoding, as OAuth 1.0a requires (encodeURIComponent leaves !'()* alone). */
export const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * The Authorization header for one request. `params` are the query string and any form body parameters (a JSON body is
 * not signed). `nonce` and `timestamp` are fixed only in tests.
 */
export function oauth1Header(method: string, url: string, params: Record<string, string>, c: XCredentials, nonce = randomBytes(16).toString("hex"), timestamp = Math.floor(Date.now() / 1000).toString()): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all)
    .map((k) => [pct(k), pct(all[k]!)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramString)}`;
  const signature = createHmac("sha1", `${pct(c.apiSecret)}&${pct(c.accessSecret)}`).update(base).digest("base64");
  const header = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.keys(header).sort().map((k) => `${pct(k)}="${pct(header[k as keyof typeof header])}"`).join(", ");
}

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  username: string;
  createdAt: string;
  conversationId?: string;
}

export interface XClient {
  me(): Promise<{ id: string; username: string }>;
  mentions(userId: string, sinceId?: string, startTime?: string): Promise<Mention[]>;
  reply(text: string, inReplyTo: string): Promise<string>;
  deleteTweet(id: string): Promise<void>;
}

const X_API = "https://api.x.com/2";

export function xClient(c: XCredentials, fetchImpl: typeof fetch = fetch): XClient {
  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const url = X_API + path;
    const qs = new URLSearchParams(query).toString();
    const r = await fetchImpl(qs ? `${url}?${qs}` : url, {
      method,
      headers: { authorization: oauth1Header(method, url, query, c), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as T & { title?: string; detail?: string };
    if (!r.ok) throw new Error(`X ${method} ${path}: ${r.status} ${j.title ?? ""} ${j.detail ?? ""}`.trim());
    return j;
  }
  return {
    async me() {
      const j = await call<{ data: { id: string; username: string } }>("GET", "/users/me");
      return j.data;
    },
    async mentions(userId, sinceId, startTime) {
      const query: Record<string, string> = {
        max_results: "50",
        "tweet.fields": "author_id,created_at,conversation_id",
        expansions: "author_id",
        "user.fields": "username",
      };
      if (sinceId) query.since_id = sinceId;
      else if (startTime) query.start_time = startTime;
      const j = await call<{ data?: { id: string; text: string; author_id: string; created_at: string; conversation_id?: string }[]; includes?: { users?: { id: string; username: string }[] } }>("GET", `/users/${userId}/mentions`, query);
      const names = new Map((j.includes?.users ?? []).map((u) => [u.id, u.username]));
      return (j.data ?? []).map((t) => ({ id: t.id, text: t.text, authorId: t.author_id, username: names.get(t.author_id) ?? t.author_id, createdAt: t.created_at, conversationId: t.conversation_id }));
    },
    async reply(text, inReplyTo) {
      const j = await call<{ data: { id: string } }>("POST", "/tweets", {}, { text, reply: { in_reply_to_tweet_id: inReplyTo } });
      return j.data.id;
    },
    async deleteTweet(id) {
      await call<{ data: { deleted: boolean } }>("DELETE", `/tweets/${id}`);
    },
  };
}
