// Copy lint for shipped text (workspace CLAUDE.md sections 1, 2 and 4; docs/ORRY-BUILD-SPEC.md section 6).
// Strips comments, then flags words and punctuation that must not reach a user. Run: node scripts/copy-lint.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dirs = ["app", "components", "lib"];
const RULES = [
  [/—|–/, "em or en dash in text"],
  [/\btestnet\b/i, "the word testnet (say development network)"],
  [/\bAPY\b|\bAPR\b|annual (yield|return)|projected/i, "projected rates"],
  [/\bunaudited\b|not audited|\bpilot\b|\bdemo\b|sample data|name pending|not financial advice|\bDYOR\b|not affiliated/i, "disclaimer wording"],
  [/\bguarantee/i, "guarantee claims"],
  [/\brisk\b|\bcaution\b|\bwarning:/i, "risk or caution lines"],
  [/cannot be undone|trades are final/i, "finality lines"],
  [/\bpause\b|\bfreeze\b/i, "admin power lines", (f) => /orry|markets|docs\/(earn|stake|claims)|stocks|swap|dark-pool/.test(f)],
  // docs/ORRY-R1-SPEC.md 2.5: the limits of wallet to wallet settlement are for the owner, never for the market pages.
  [/revok|allowance|issuer|\bblock(ed|s)? (a|one|the) trader|drop(s|ped)? out|custody/i, "settlement limits (spec 2.5)", (f) => /markets|stocks|swap|dark-pool/.test(f), true],
];

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mdx?)$/.test(n)) files.push(p);
  }
};
for (const d of dirs) walk(join(root, d));

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
let bad = 0;
for (const f of files) {
  const rel = relative(root, f);
  const lines = strip(readFileSync(f, "utf8")).split("\n");
  lines.forEach((line, i) => {
    for (const [re, why, only, textOnly] of RULES) {
      if (only && !only(rel)) continue;
      // Text-only rules read what a person sees: string literals and JSX text, not identifiers.
      const target = textOnly ? [...line.matchAll(/"([^"]*)"|`([^`]*)`|>([^<>{}]+)</g)].map((m) => m[3] ?? ((m[1] ?? m[2] ?? "").includes(" ") ? m[1] ?? m[2] : "")).join(" ") : line;
      if (re.test(target)) {
        bad++;
        console.log(`${rel}:${i + 1}  ${why}: ${line.trim().slice(0, 140)}`);
      }
    }
  });
}
console.log(bad === 0 ? `copy-lint: ${files.length} files clean` : `copy-lint: ${bad} finding(s) in ${files.length} files`);
process.exit(bad === 0 ? 0 : 1);
