"use client";

import { useEffect, useState } from "react";
import { EXPLORER_URL } from "@/lib/orry/config";
import type { TradeVenue } from "@/lib/trade-venues";

/**
 * The ORRY contract address under the hero buttons: label, shortened address linked to the explorer, copy button.
 * The address comes from GET /api/ca (server-side `ORRERY_CA`), so it changes without a code change; until it loads,
 * or when it is unset, nothing renders. Beside the pill, one button per venue where ORRY trades (same answer, `trade`).
 */
export function ContractAddress() {
  const [ca, setCa] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [venues, setVenues] = useState<TradeVenue[]>([]);

  useEffect(() => {
    let live = true;
    fetch("/api/ca")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ca?: unknown; trade?: unknown } | null) => {
        if (!live || typeof d?.ca !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(d.ca)) return;
        setCa(d.ca);
        if (Array.isArray(d.trade)) {
          setVenues((d.trade as TradeVenue[]).filter((v) => typeof v?.name === "string" && typeof v?.url === "string" && v.url.startsWith("https://")));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!ca) return null;
  const short = `${ca.slice(0, 10)}…${ca.slice(-6)}`;
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(ca);
      ok = true;
    } catch {
      // the async clipboard can be refused (permissions, embedded views): fall back to a selected textarea
      const t = document.createElement("textarea");
      t.value = ca;
      t.setAttribute("readonly", "");
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      t.remove();
    }
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="lp-ca-row">
    <div className="lp-ca">
      <span className="lp-ca-label">CA</span>
      {EXPLORER_URL ? (
        <a className="lp-ca-addr" href={`${EXPLORER_URL}/token/${ca}`} target="_blank" rel="noreferrer" title={ca}>
          {short}
        </a>
      ) : (
        <span className="lp-ca-addr" title={ca}>
          {short}
        </span>
      )}
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : "Copy ORRY's contract address"} title={copied ? "Copied" : "Copy"}>
        {copied ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <span className="sr-only" aria-live="polite">{copied ? "Address copied to clipboard" : ""}</span>
    </div>
    {venues.map((v) => (
      <a key={v.url} className="lp-trade" href={v.url} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {v.icon ? <img src={v.icon} alt="" width={20} height={20} /> : null}
        Trade on {v.name}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 17 17 7M8 7h9v9" />
        </svg>
      </a>
    ))}
    </div>
  );
}
