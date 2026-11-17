"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ORRY_ROUTES } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import { MARKET_ROUTES } from "@/lib/markets/config";
import { R2_ROUTES } from "@/lib/r2/config";
import { COMMUNITY_ROUTES, useCommunity } from "@/lib/community/config";
import { CREDIT_ROUTES } from "@/lib/credit/api";
import { Brand } from "./Brand";
import { WalletButton } from "./WalletButton";
import { DASHBOARD_HREF } from "@/lib/dashboard";
import { XIcon } from "./XIcon";
import { X_URL } from "./social";

type NavLink = { href: string; label: string; match?: string[] };
/** A protocol section: its pages, and the first open one (none while the whole section is held). */
type Section = { label: string; pages: { href: string; label: string }[]; liveHref?: string };

const HOME: NavLink = { href: "/", label: "Product" };
// Agent limits and credits are sections of the dashboard, so the site nav carries one link to it.
const CORE: NavLink[] = [
  { href: DASHBOARD_HREF, label: "Dashboard" },
  { href: "/signer", label: "Readings" },
];
const DOCS: NavLink = { href: "/docs", label: "Docs" };

const isCurrent = (path: string, l: NavLink) =>
  l.match ? l.match.some((h) => path === h || path.startsWith(`${h}/`)) : l.href === "/" ? path === "/" : path === l.href || path.startsWith(`${l.href}/`);

export function Nav() {
  const path = usePathname();
  const releases = useReleases();
  const community = useCommunity();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Until the release switch has answered, every section counts as held, so nothing jumps out of the menu by mistake.
  const live = (f: Parameters<typeof releases.isLive>[0]) => releases.ready && releases.isLive(f);
  const sections: Section[] = [
    { label: "ORRY", pages: ORRY_ROUTES, liveHref: ORRY_ROUTES.find((r) => live(r.feature))?.href },
    { label: "Markets", pages: MARKET_ROUTES, liveHref: MARKET_ROUTES.find((r) => live(r.feature))?.href },
    { label: "Merchants", pages: [{ href: "/merchants", label: "Merchant payments" }], liveHref: live("facilitator") ? "/merchants" : undefined },
    { label: "Community", pages: COMMUNITY_ROUTES, liveHref: community.ready ? COMMUNITY_ROUTES.find((r) => r.features.some(community.live))?.href : undefined },
    {
      label: "Data",
      pages: [{ href: "/data", label: "Data market" }, { href: "/data/providers", label: "Data providers" }],
      liveHref: live("data") ? "/data" : live("data-providers") ? "/data/providers" : undefined,
    },
    { label: "Tools", pages: R2_ROUTES, liveHref: R2_ROUTES.find((r) => live(r.feature))?.href },
    // "Agent credit", so it never reads like the top-level Credits (check packs).
    {
      label: "Agent credit",
      pages: [{ href: "/credit", label: "Credit pools" }, { href: "/attesters", label: "Attesters" }],
      liveHref: CREDIT_ROUTES.find((r) => live(r.feature))?.href,
    },
    { label: "Agent Launch", pages: [{ href: "/launch", label: "Start a coin" }], liveHref: live("launch") ? "/launch" : undefined },
  ];
  const openSections = sections.filter((s) => s.liveHref);
  const heldSections = sections.filter((s) => !s.liveHref);

  const links: NavLink[] = [
    HOME,
    ...CORE,
    ...openSections.map((s) => ({ href: s.liveHref!, label: s.label, match: s.pages.map((p) => p.href) })),
    DOCS,
  ];
  const heldCurrent = heldSections.some((s) => s.pages.some((p) => path === p.href || path.startsWith(`${p.href}/`)));

  // The menu closes on a page change, a click outside it, and Escape (focus goes back to its button).
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      wrap.current?.querySelector<HTMLButtonElement>(".nav-more")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <nav className="nav">
      <Brand />
      <div className="nav-menu" ref={wrap}>
        <div className="nav-links">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={isCurrent(path, l) ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </div>
        {heldSections.length ? (
          <button
            type="button"
            className="nav-more"
            aria-expanded={open}
            aria-controls="nav-soon"
            aria-current={heldCurrent ? "page" : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            Coming soon
            <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12">
              <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
        {heldSections.length ? (
          <div id="nav-soon" className="nav-panel" hidden={!open}>
            {heldSections.map((s) => (
              <div key={s.label} className="nav-group">
                <p>{s.label}</p>
                <ul>
                  {s.pages.map((p) => (
                    <li key={p.href}>
                      <Link href={p.href} aria-current={path === p.href ? "page" : undefined} onClick={() => setOpen(false)}>
                        {p.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="nav-actions">
        {X_URL ? (
          <a aria-label="Follow Orrery on X" className="x-link" href={X_URL} target="_blank" rel="noreferrer">
            <XIcon />
          </a>
        ) : null}
        {X_URL ? <span className="nav-divider" aria-hidden="true" /> : null}
        <WalletButton />
      </div>
    </nav>
  );
}
