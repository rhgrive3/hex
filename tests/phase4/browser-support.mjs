import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

export async function loadPlaywright() {
  const unwrap = (m) => (m?.chromium ? m : (m?.default?.chromium ? m.default : null));
  try { const got = unwrap(await import("playwright")); if (got) return got; } catch {}
  const cache = path.join(process.env.HOME || "", ".npm", "_npx");
  if (!fs.existsSync(cache)) return null;
  for (const directory of fs.readdirSync(cache)) {
    const candidate = path.join(cache, directory, "node_modules", "playwright", "index.js");
    if (!fs.existsSync(candidate)) continue;
    try { const got = unwrap(await import(pathToFileURL(candidate).href)); if (got) return got; } catch {}
  }
  return null;
}

export function servePhase4Root() {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
  };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
