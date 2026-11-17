/** One line for the server log: the error's short message with every URL removed, since an RPC URL can carry a key. */
export function logLine(err: unknown): string {
  const e = err as { name?: string; shortMessage?: string; message?: string };
  const text = (e.shortMessage ?? e.message ?? String(err)).split("\n")[0] ?? "";
  return `${e.name ?? "Error"}: ${text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url]")}`;
}
