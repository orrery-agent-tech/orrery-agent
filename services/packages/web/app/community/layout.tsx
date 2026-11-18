import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { CommunityTabs } from "@/components/community/shell";
import "./community.css";

/** Frame of every community page: site nav, the community tab row, the page, the footer. */
export default function CommunityLayout({ children }: { children: ReactNode }) {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="app-main">
        <CommunityTabs />
        {children}
      </main>
      <Footer />
    </div>
  );
}
