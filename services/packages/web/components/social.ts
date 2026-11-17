/**
 * Social links for the site chrome. Each one renders only when configured, so the site never prints a handle or an
 * link that does not belong to Orrery. NEXT_PUBLIC_X_HANDLE takes the handle with or without the leading "@".
 */
const handle = (process.env.NEXT_PUBLIC_X_HANDLE ?? "").trim().replace(/^@+/, "");
const valid = /^[A-Za-z0-9_]{1,15}$/.test(handle);

export const X_HANDLE: string | undefined = valid ? `@${handle}` : undefined;
export const X_URL: string | undefined = valid ? `https://x.com/${handle}` : undefined;
