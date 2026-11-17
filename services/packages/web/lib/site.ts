/**
 * The site's own address, for metadata (share images, canonical URLs) and the dashboard's link home. In order:
 * NEXT_PUBLIC_SITE_URL when set (the custom domain once it serves the site); else the Vercel project's production
 * address, which Vercel exposes at build time and which becomes the custom domain on its own once one is attached;
 * else the local dev server.
 */
function siteUrl(): string {
  const explicit = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (/^https?:\/\//.test(explicit)) return explicit.replace(/\/+$/, "");
  const vercel = (process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}

export const SITE_URL = siteUrl();
export const SITE_HOST = new URL(SITE_URL).host;
