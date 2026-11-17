#!/usr/bin/env -S npx tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpConfig } from "./config.js";
import { createOrreryMcpServer } from "./server.js";

/** stdio entry point: `orrery-mcp` (configure it in an MCP client; settings come from the environment). */
const server = createOrreryMcpServer({ config: loadMcpConfig() });
await server.connect(new StdioServerTransport());
