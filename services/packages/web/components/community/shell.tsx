"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { COMMUNITY_ROUTES, useCommunity, type CommunityFeature } from "@/lib/community/config";
import { COMING_SOON, SOON_TAG } from "@/lib/orry/config";

/** Second row of navigation across the community pages. Held pages stay listed, marked "Coming soon". */
export function CommunityTabs() {
  const path = usePathname();
  const c = useCommunity();
  return (
    <nav className="rc-tabs" aria-label="Community">
      {COMMUNITY_ROUTES.map((r) => {
        const live = !c.ready || r.features.some(c.live);
        const current = path === r.href;
        return (
          <Link key={r.href} href={r.href} aria-current={current ? "page" : undefined} className={live ? undefined : "is-held"}>
            {r.label}
            {live ? null : <small>{COMING_SOON}</small>}
            {current ? <motion.span className="rc-tab-line" layoutId="cm-tab-line" transition={{ type: "spring", stiffness: 380, damping: 34 }} aria-hidden="true" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Shows `children` while one of the features is open and its contracts are named, `held` otherwise. Until the release
 * switch and the config answer it shows a short wait, so an open page never flashes "Coming soon" first.
 */
export function CommunityGate({ feature, held, children }: { feature: CommunityFeature | CommunityFeature[]; held: ReactNode; children: ReactNode }) {
  const c = useCommunity();
  if (!c.ready) return <div className="rc-gate-wait" aria-busy="true" aria-label="Loading" />;
  const any = (Array.isArray(feature) ? feature : [feature]).some(c.live);
  return <>{any ? children : held}</>;
}

/** The dashboard sidebar's Community entry, with the same quiet "Soon" as the held sections. */
export function CommunitySideLink() {
  const c = useCommunity();
  const first = COMMUNITY_ROUTES.find((r) => r.features.some(c.live));
  const held = c.ready && !first;
  return (
    <Link href={first?.href ?? COMMUNITY_ROUTES[0]!.href} className={held ? "is-held" : undefined}>
      <svg className="dsh-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 5h16v10H9l-5 4z" />
        <path d="M8 9h8" />
        <path d="M8 12h5" />
      </svg>
      <span>Community</span>
      {held ? <small>{SOON_TAG}</small> : null}
    </Link>
  );
}
