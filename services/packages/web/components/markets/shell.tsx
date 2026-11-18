import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { MarketTabs, SealedStrip } from "./parts";
import { MarketsRuntime } from "./runtime";

/** Frame of every market page: site nav, the market tab row, this wallet's live orders, the page, the footer. */
export function MarketsShell({ children }: { children: ReactNode }) {
  return (
    <div className="product-page rc-page mk-page">
      <Nav />
      <main className="app-main">
        <MarketsRuntime>
          <MarketTabs />
          <SealedStrip />
          {children}
        </MarketsRuntime>
      </main>
      <Footer />
    </div>
  );
}
