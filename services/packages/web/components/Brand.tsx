"use client";

import Link from "next/link";
import { useId } from "react";

/**
 * The Orrery mark, "Orbit O": a cut serif O (stress tilted like a letter cut by hand) with one orbit crossing in front
 * of it and a body riding that orbit. The orbit passes through a gap masked out of the O, so the mark needs no
 * background colour. public/art/mark.svg (design/art/build_art.py) is the same drawing on a navy tile; the source and
 * the concepts it was chosen from are in design/mainspring/logo/.
 */
export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  const mask = `orbit-gap-${useId().replace(/:/g, "")}`;
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true" focusable="false" fill="none">
      <defs>
        <mask id={mask}>
          <rect width="40" height="40" fill="#fff" />
          <path d="M39 20A19 5.4 0 0 1 1 20" stroke="#000" strokeWidth="4" transform="rotate(-22 20 20)" />
        </mask>
      </defs>
      <path
        mask={`url(#${mask})`}
        fill="#d9967a"
        fillRule="evenodd"
        transform="rotate(-14 20 20)"
        d="M4.2 20a15.8 16.4 0 1 0 31.6 0a15.8 16.4 0 1 0-31.6 0ZM10.4 20a9.6 12.9 0 1 0 19.2 0a9.6 12.9 0 1 0-19.2 0Z"
      />
      <path d="M37.2 21.6A19 5.4 0 0 1 1 20" stroke="#d9967a" strokeWidth="1.5" strokeLinecap="round" transform="rotate(-22 20 20)" />
      <circle cx="36.6" cy="12.9" r="2.6" fill="#d9967a" />
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link className="brand" href={href} aria-label="Orrery home">
      <BrandMark />
      <span>Orrery</span>
    </Link>
  );
}
