"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { COMING_SOON } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import { R2_ROUTES } from "@/lib/r2/config";
import "./r2.css";

/** Second row of navigation across the lane L3 pages. Held pages stay listed, marked "Coming soon". */
export function R2Tabs() {
  const path = usePathname();
  const releases = useReleases();
  return (
    <nav className="rc-tabs" aria-label="Prediction, limit order, Shield and gas pages">
      {R2_ROUTES.map((r) => {
        const live = !releases.ready || releases.isLive(r.feature);
        const current = path === r.href || path.startsWith(`${r.href}/`);
        return (
          <Link key={r.href} href={r.href} aria-current={current ? "page" : undefined} className={live ? undefined : "is-held"}>
            {r.label}
            {live ? null : <small>{COMING_SOON}</small>}
          </Link>
        );
      })}
    </nav>
  );
}

/** Frame of every lane L3 page: site nav, the tab row, the page, the footer. */
export function R2Shell({ children }: { children: ReactNode }) {
  return (
    <div className="product-page rc-page r2-page">
      <Nav />
      <main className="app-main">
        <R2Tabs />
        {children}
      </main>
      <Footer />
    </div>
  );
}
