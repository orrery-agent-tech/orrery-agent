import type { ReactNode } from "react";

/** Every route enters with a short rise; CSS only, so it never waits for hydration. */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="route-enter">{children}</div>;
}
