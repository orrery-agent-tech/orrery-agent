import type { ConsoleIcon } from "@/lib/dashboard";

/** Line icons for the dashboard sidebar, 20 px, stroke in the current colour. */
const PATHS: Record<ConsoleIcon | "menu", string[]> = {
  overview: ["M4 4h7v7H4z", "M13 4h7v4h-7z", "M13 10h7v10h-7z", "M4 13h7v7H4z"],
  credits: ["M4 8a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v8a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2z", "M10 9.5v5", "M14 9.5v5"],
  agents: ["M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z", "M9 12l2 2 4-4"],
  merchant: ["M4 7h16v12H4z", "M4 10h16", "M8 15h3"],
  positions: ["M4 19V5", "M4 19h16", "M8 15l4-4 3 3 5-6"],
  orders: ["M7 4h10l2 4v12H5V8z", "M5 8h14", "M9 12h6", "M9 16h4"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
};

export function ConsoleIconSvg({ name }: { name: ConsoleIcon | "menu" }) {
  return (
    <svg className="dsh-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
