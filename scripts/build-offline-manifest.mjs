// Regenerates /offline-manifest.json (the service worker's precache list).
// Run before each deploy:  node scripts/build-offline-manifest.mjs
// Cloudflare Pages build command: node scripts/build-offline-manifest.mjs
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set(["node_modules", ".git", "tests", "scripts", "file-association", "public", ".wrangler"]);
const SKIP_FILES = new Set(["_redirects", "_headers", "vercel.json", "wrangler.toml", "package.json", "package-lock.json", ".gitignore", "sw.js", "offline-manifest.json"]);
const MAX_BYTES = 24 * 1024 * 1024; // Cloudflare Pages per-file limit is 25 MiB

const out = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); continue; }
    if (SKIP_FILES.has(name) || st.size > MAX_BYTES) continue;
    out.push("/" + relative(ROOT, full).split(sep).join("/"));
  }
})(ROOT);

out.sort();
writeFileSync(join(ROOT, "offline-manifest.json"), JSON.stringify(out));
console.log("offline-manifest.json:", out.length, "files");
