"use client";

import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";

/** True on a mouse or trackpad; touch screens get no pointer effects. */
function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const q = matchMedia("(pointer: fine)");
    setFine(q.matches);
    const on = () => setFine(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return fine;
}

const SPRING = { stiffness: 160, damping: 18, mass: 0.6 };

/** Leans its child toward the pointer, at most `max` degrees, and settles back when the pointer leaves. */
export function Tilt({ children, className, max = 6 }: { children: ReactNode; className?: string; max?: number }) {
  const fine = useFinePointer();
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rx = useSpring(useTransform(y, [-0.5, 0.5], [max, -max]), SPRING);
  const ry = useSpring(useTransform(x, [-0.5, 0.5], [-max, max]), SPRING);
  if (!fine || reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 1000 }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - r.left) / r.width - 0.5);
        y.set((e.clientY - r.top) / r.height - 0.5);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}

/** A primary action that follows the pointer a few pixels and springs back. */
export function Magnetic({ children, pull = 6 }: { children: ReactNode; pull?: number }) {
  const fine = useFinePointer();
  const reduce = useReducedMotion();
  const x = useSpring(0, SPRING);
  const y = useSpring(0, SPRING);
  if (!fine || reduce) return <>{children}</>;
  return (
    <motion.span
      className="magnetic"
      style={{ x, y }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        x.set(((e.clientX - r.left) / r.width - 0.5) * 2 * pull);
        y.set(((e.clientY - r.top) / r.height - 0.5) * 2 * pull);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.span>
  );
}
