import { oauth1Header, type XCredentials } from "./support-x.js";

/**
 * Posts with a video on X API v2, as the account in the credentials (OAuth 1.0a user context): the chunked upload
 * (initialize, append, finalize, status) of docs.x.com/x-api/media/quickstart/media-upload-chunked, then POST /2/tweets
 * with media.media_ids. JSON and multipart bodies are not part of the OAuth 1.0a signature; query parameters are.
 */

const X_API = "https://api.x.com/2";
const CHUNK = 4 * 1024 * 1024; // the docs advise at most 5 MB a segment (server limit 8 MB)

export interface ProcessingInfo {
  state: "pending" | "in_progress" | "succeeded" | "failed";
  check_after_secs?: number;
  progress_percent?: number;
}

export function xMedia(c: XCredentials, fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  async function call<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; json?: unknown; form?: FormData } = {}): Promise<T> {
    const url = X_API + path;
    const query = opts.query ?? {};
    const qs = new URLSearchParams(query).toString();
    const headers: Record<string, string> = { authorization: oauth1Header(method, url, query, c) };
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    const r = await fetchImpl(qs ? `${url}?${qs}` : url, {
      method,
      headers,
      body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await r.json().catch(() => ({}))) as T & { title?: string; detail?: string; errors?: unknown };
    if (!r.ok) throw new Error(`X ${method} ${path}: ${r.status} ${j.title ?? ""} ${j.detail ?? ""}`.trim());
    return j;
  }

  /** Uploads media for a post (chunked); resolves with the media id once X reports it ready. */
  async function upload(bytes: Uint8Array, mediaType: string, category: "tweet_video" | "tweet_image" | "tweet_gif", log: (s: string) => void = () => {}): Promise<string> {
    const init = await call<{ data: { id: string } }>("POST", "/media/upload/initialize", { json: { media_type: mediaType, total_bytes: bytes.length, media_category: category } });
    const id = init.data.id;
    for (let i = 0, seg = 0; i < bytes.length; i += CHUNK, seg++) {
      const form = new FormData();
      form.append("segment_index", String(seg));
      form.append("media", new Blob([bytes.slice(i, i + CHUNK)], { type: "application/octet-stream" }), `segment-${seg}`);
      await call("POST", `/media/upload/${id}/append`, { form });
      log(`appended segment ${seg}`);
    }
    const fin = await call<{ data: { processing_info?: ProcessingInfo } }>("POST", `/media/upload/${id}/finalize`);
    let info = fin.data.processing_info;
    for (let tries = 0; info && info.state !== "succeeded"; tries++) {
      if (info.state === "failed") throw new Error("X could not process the media.");
      if (tries > 60) throw new Error("X is still processing the media; try again later.");
      await sleep(Math.max(1, info.check_after_secs ?? 2) * 1000);
      const st = await call<{ data: { processing_info?: ProcessingInfo } }>("GET", "/media/upload", { query: { command: "STATUS", media_id: id } });
      info = st.data.processing_info;
      log(`processing ${info?.state ?? "done"} ${info?.progress_percent ?? ""}`);
    }
    return id;
  }

  /** Uploads an MP4 for a post. */
  const uploadVideo = (bytes: Uint8Array, log: (s: string) => void = () => {}) => upload(bytes, "video/mp4", "tweet_video", log);

  /** Uploads a PNG or JPEG for a post. */
  const uploadImage = (bytes: Uint8Array, mediaType: "image/png" | "image/jpeg" = "image/png") => upload(bytes, mediaType, "tweet_image");

  /** Creates a post; `replyTo` makes it a reply, `quote` quotes another post. Returns the post id. */
  async function post(text: string, mediaIds: string[] = [], opts: { replyTo?: string; quote?: string } = {}): Promise<string> {
    const body: Record<string, unknown> = { text };
    if (mediaIds.length) body.media = { media_ids: mediaIds };
    if (opts.replyTo) body.reply = { in_reply_to_tweet_id: opts.replyTo };
    if (opts.quote) body.quote_tweet_id = opts.quote;
    const j = await call<{ data: { id: string } }>("POST", "/tweets", { json: body });
    return j.data.id;
  }

  return { upload, uploadVideo, uploadImage, post };
}
