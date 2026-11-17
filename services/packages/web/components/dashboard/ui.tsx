"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { EXPLORER_URL, SOON_TAG } from "@/lib/orry/config";

/** A titled card. `action` is a link on the right of the title row. */
export function Panel({ title, action, soon, children, className }: { title: string; action?: { href: string; label: string }; soon?: boolean; children: ReactNode; className?: string }) {
  return (
    <section className={`cp-panel${className ? ` ${className}` : ""}`}>
      <header className="cp-panel-head">
        <h2>
          {title}
          {soon ? <small className="cp-soon">{SOON_TAG}</small> : null}
        </h2>
        {action ? <Link href={action.href}>{action.label}</Link> : null}
      </header>
      {children}
    </section>
  );
}

/** One figure with its label; `value` undefined shows a quiet loading mark. */
export function Stat({ label, value, unit, hint }: { label: string; value?: ReactNode; unit?: string; hint?: ReactNode }) {
  return (
    <div className="cp-stat">
      <span className="cp-stat-label">{label}</span>
      <span className={`cp-stat-value${value === undefined ? " is-wait" : ""}`}>
        {value === undefined ? "…" : value}
        {unit && value !== undefined ? <em>{unit}</em> : null}
      </span>
      {hint ? <span className="cp-stat-hint">{hint}</span> : null}
    </div>
  );
}

/** Label and value rows. */
export function Rows({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="cp-rows">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Nothing here yet: one line and, when there is a next step, its link. */
export function Empty({ text, action }: { text: string; action?: { href: string; label: string } }) {
  return (
    <div className="cp-empty">
      <p>{text}</p>
      {action ? (
        <Link className="cp-btn" href={action.href}>
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/** A held section's body: one line on what appears here; the panel title carries the Soon tag. */
export function SoonBody({ text }: { text: string }) {
  return (
    <div className="cp-empty cp-held">
      <p>{text}</p>
    </div>
  );
}

/** A quiet loading block while a read is on its way. */
export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="cp-loading" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

/** A colour seeded by the address, so every wallet has the same mark everywhere. */
export function Avatar({ address, size = 48 }: { address: string; size?: number }) {
  const h = parseInt(address.slice(2, 6), 16) % 360;
  return <span className="cp-avatar" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${h} 72% 58%), hsl(${(h + 70) % 360} 64% 44%))` }} aria-hidden="true" />;
}

/** Shortened address with copy and an explorer link. */
export function AddressPill({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="cp-pill">
      <span className="mono">{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(address).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {EXPLORER_URL ? (
        <a href={`${EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer">
          Explorer
        </a>
      ) : null}
    </span>
  );
}
