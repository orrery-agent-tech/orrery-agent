import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, request } from "undici";

/**
 * Fetch for URLs chosen by agents (14 §5): resolve once, refuse non-public addresses, connect to the validated IP (SNI and
 * Host stay the name), re-check at every redirect hop, refuse encoded bodies, cap the body size.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["2002::", 16],
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** True for addresses a probe may connect to. IPv4-mapped IPv6 is judged by its IPv4 part. */
export function isPublicAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return !blocked.check(ip, "ipv4");
  if (fam === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower.startsWith("::ffff:")) return false; // hex-form mapped addresses
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

export class ProbeError extends Error {}

export interface SafeFetchOptions {
  allowPrivate?: boolean; // tests on a local chain only
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  body: Buffer;
  url: string;
}

async function resolve(host: string, allowPrivate: boolean): Promise<{ address: string; family: 4 | 6 }> {
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  const literal = isIP(bare);
  const addrs = literal ? [{ address: bare, family: literal as 4 | 6 }] : await dnsLookup(bare, { all: true, verbatim: true });
  if (addrs.length === 0) throw new ProbeError(`no address for ${host}`);
  if (!allowPrivate) {
    for (const a of addrs) if (!isPublicAddress(a.address)) throw new ProbeError(`non-public address for ${host}`);
  }
  const first = addrs[0]!;
  return { address: first.address, family: first.family as 4 | 6 };
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const allowPrivate = opts.allowPrivate ?? false;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) throw new ProbeError("https only");
    if (url.username || url.password) throw new ProbeError("credentials in URL");
    if (url.port && url.port !== "443" && !allowPrivate) throw new ProbeError("port 443 only");
    const { address, family } = await resolve(url.hostname, allowPrivate);
    const dispatcher = new Agent({
      connect: {
        timeout: timeoutMs,
        lookup: (_h: string, _o: unknown, cb: (e: Error | null, addrs: { address: string; family: number }[]) => void) =>
          cb(null, [{ address, family }]),
      } as never,
    });
    try {
      const res = await request(url, {
        method: "GET",
        dispatcher,
        headers: { "accept-encoding": "identity", accept: "application/json, */*;q=0.5", "user-agent": "orrery-prober/1" },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const loc = res.headers.location;
        await res.body.dump();
        if (!loc || Array.isArray(loc)) throw new ProbeError("redirect without location");
        url = new URL(loc, url);
        continue;
      }
      const enc = res.headers["content-encoding"];
      if (enc && enc !== "identity") {
        await res.body.dump();
        throw new ProbeError("encoded body refused");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          res.body.destroy();
          throw new ProbeError("body too large");
        }
        chunks.push(chunk as Buffer);
      }
      return { status: res.statusCode, body: Buffer.concat(chunks), url: url.toString() };
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }
  throw new ProbeError("too many redirects");
}
