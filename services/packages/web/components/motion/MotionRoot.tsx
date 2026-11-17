"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * One observer for the whole site. Elements marked `data-reveal` get `is-in` once they enter the viewport (CSS does the
 * movement), and `data-inview` elements carry `is-inview` only while visible, so their loops pause off screen. Elements
 * added later, such as a lookup result, are picked up as they mount. The `js-motion` class on <html> (set before paint
 * by the inline script in the layout) is what hides not-yet-revealed elements; `motion-ready` tells CSS the observer runs.
 */
export function MotionRoot() {
  const path = usePathname();
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains("js-motion")) return;
    const reveal = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          reveal.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    const live = new IntersectionObserver((entries) => {
      for (const e of entries) e.target.classList.toggle("is-inview", e.isIntersecting);
    });
    const seen = new WeakSet<Element>();
    const scan = () => {
      document.querySelectorAll("[data-reveal]:not(.is-in)").forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        reveal.observe(el);
      });
      document.querySelectorAll("[data-inview]").forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        live.observe(el);
      });
    };
    scan();
    root.classList.add("motion-ready");
    let queued = false;
    const mo = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      reveal.disconnect();
      live.disconnect();
    };
  }, [path]);
  return null;
}

/** Runs before first paint: motion classes only when the visitor has not asked for reduced motion. */
export const MOTION_BOOT = `try{if(!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.classList.add("js-motion")}catch(e){}`;
