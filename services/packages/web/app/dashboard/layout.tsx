import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ConsoleShell } from "@/components/dashboard/Shell";

export const metadata: Metadata = {
  title: { default: "Orrery · Dashboard", template: "Orrery · %s" },
  description: "Your Orrery console: the orbit of each agent, the address you get paid at, your positions and your open orders.",
};

/** The dashboard is its own app: no site nav or footer, its own sidebar and top bar. */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
