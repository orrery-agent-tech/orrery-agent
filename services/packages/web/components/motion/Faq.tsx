"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useId, useState } from "react";

/** Questions that open in place: the answer's height eases open and the plus turns into a cross. */
export function Faq({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const id = useId();
  return (
    <div className="lp-faq-list">
      {items.map((f, i) => {
        const isOpen = open === i;
        return (
          <div key={f.q} className={`faq-item${isOpen ? " is-open" : ""}`}>
            <h3>
              <button type="button" aria-expanded={isOpen} aria-controls={`${id}-${i}`} onClick={() => setOpen(isOpen ? null : i)}>
                <span>{f.q}</span>
                <i className="faq-icon" aria-hidden="true" />
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {isOpen ? (
                <motion.div
                  id={`${id}-${i}`}
                  role="region"
                  key="a"
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduce ? { height: 0, opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
                  style={{ overflow: "hidden" }}
                >
                  <p>{f.a}</p>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
