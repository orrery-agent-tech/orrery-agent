import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@orrery/shared", "@orrery/sdk"],
  reactStrictMode: true,
  // Operator and Credits live in the dashboard. Their old addresses keep working (query strings carry over).
  async redirects() {
    return [
      { source: "/operator", destination: "/dashboard/agents", permanent: false },
      { source: "/credits", destination: "/dashboard/credits", permanent: false },
      // The market venues were renamed on 2026-11-17: Private Swap is Eclipse, Dark Pool is Quiet Book.
      { source: "/swap", destination: "/eclipse", permanent: true },
      { source: "/dark-pool", destination: "/quiet-book", permanent: true },
    ];
  },
};
export default config;
