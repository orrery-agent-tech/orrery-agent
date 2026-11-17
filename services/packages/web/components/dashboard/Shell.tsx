"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { BrandMark } from "@/components/Brand";
import { SITE_HOST } from "@/lib/site";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useConnection } from "wagmi";
import { CONSOLE_SECTIONS, CREDITS_HREF, DASHBOARD_HREF, sectionFor, type ConsoleSection } from "@/lib/dashboard";
import { deployed } from "@/lib/config";
import { SOON_TAG } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import { WalletButton } from "../WalletButton";
import { ConsoleIconSvg } from "./icons";
import { CommunitySideLink } from "../community/shell";
import { CreditSideLink } from "../credit/shell";
import { CreditsPrices } from "./credits";
import type { OrryFeature } from "@/lib/orry/config";

/** Every other built feature, so the dashboard lists all of Orrery; held ones read "Soon" and open their held page. */
const MORE: { href: string; label: string; features: OrryFeature[] }[] = [
  { href: "/data", label: "Data", features: ["data", "data-providers"] },
  { href: "/launch", label: "Agent Launch", features: ["launch"] },
  { href: "/shield", label: "Shield", features: ["shield"] },
  { href: "/predict", label: "Predict", features: ["predict"] },
  { href: "/limit-orders", label: "Limit orders", features: ["limit-orders"] },
  { href: "/gas", label: "Gas in ORRY", features: ["paymaster"] },
];

/**
 * The dashboard's own app shell, apart from the marketing site: a sidebar of management sections, a top bar with the
 * section's title and the wallet, and the section's page. Without a connected wallet the page asks for one.
 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const releases = useReleases();
  const { isConnected, address, status } = useConnection();
  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => setMenuOpen(false), [path]);
  const section = sectionFor(path);
  const held = (s: ConsoleSection) => (s.core && !deployed) || Boolean(s.features && releases.ready && !s.features.some((f) => releases.isLive(f)));
  const settling = !mounted || status === "reconnecting" || status === "connecting";

  return (
    <div className="dsh-app">
      <aside className={`dsh-side${menuOpen ? " is-open" : ""}`} aria-label="Dashboard">
        <Link className="dsh-brand" href={DASHBOARD_HREF} aria-label="Orrery dashboard">
          <BrandMark />
          <span>Orrery</span>
        </Link>
        <nav className="dsh-nav">
          {CONSOLE_SECTIONS.map((s) => (
            <Link key={s.href} href={s.href} aria-current={s.href === section.href ? "page" : undefined} className={held(s) ? "is-held" : undefined}>
              <ConsoleIconSvg name={s.icon} />
              <span>{s.label}</span>
              {held(s) ? <small>{SOON_TAG}</small> : null}
            </Link>
          ))}
          <CommunitySideLink />
          <CreditSideLink />
        </nav>
        <p className="dsh-group">Elsewhere in Orrery</p>
        <nav className="dsh-nav dsh-more" aria-label="Elsewhere in Orrery">
          {MORE.map((m) => {
            const isHeld = releases.ready && !m.features.some((f) => releases.isLive(f));
            return (
              <Link key={m.href} href={m.href} className={isHeld ? "is-held" : undefined}>
                <span>{m.label}</span>
                {isHeld ? <small>{SOON_TAG}</small> : null}
              </Link>
            );
          })}
        </nav>
        <div className="dsh-side-foot">
          <Link href="/docs">Docs</Link>
          <Link href="/">{SITE_HOST}</Link>
        </div>
      </aside>
      {menuOpen ? <button type="button" className="dsh-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}

      <div className="dsh-main">
        <header className="dsh-top">
          <button type="button" className="dsh-menu" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <ConsoleIconSvg name="menu" />
          </button>
          <div className="dsh-title">
            <h1>{section.label}</h1>
            <p>{section.lead}</p>
          </div>
          <div className="dsh-actions">
            <WalletButton />
          </div>
        </header>
        <main className="dsh-body">
          {settling ? (
            <div className="dsh-wait" aria-busy="true" aria-label="Loading" />
          ) : isConnected && address ? (
            children
          ) : (
            <>
              <section className="dsh-connect">
                <img src="/art/mark.svg" alt="" width={44} height={44} />
                <h2>Connect a wallet to view {section.href === DASHBOARD_HREF ? "your dashboard" : section.label}.</h2>
                <p>{section.href === DASHBOARD_HREF ? "Your agents' caps, credits, payment address, positions and orders, all read from the chain for the connected wallet." : section.lead}</p>
                <WalletButton />
              </section>
              {section.href === CREDITS_HREF ? <CreditsPrices /> : null}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
