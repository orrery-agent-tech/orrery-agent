import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@orrery/shared", "@orrery/sdk"],
  reactStrictMode: true,
  // Operator and Credits live in the dashboard. Their old addresses keep working (query strings carry over).
  async redirects() {
    return [
      { source: "/operator", destination: "/dashboard/agents", permanent: false },
      { source: "/credits", destination: "/dashboard/credits", permanent: false },
    ];
  },
};
export default config;
