import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPuzzleDataset } from "./puzzle-dataset.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const puzzles = createPuzzleDataset({ archivePath: resolve(root, "lichess_db_puzzle.csv.zst") });
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".nnue", "application/octet-stream"],
  [".json", "application/json; charset=utf-8"]
]);

function getPuzzleCorsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
  } catch {
    return {};
  }
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname === "/api/puzzles/status" || pathname === "/api/puzzles") {
    const corsHeaders = getPuzzleCorsHeaders(request);
    if (request.method === "OPTIONS") {
      if (!corsHeaders["Access-Control-Allow-Origin"]) {
        response.writeHead(403).end("Cross-origin puzzle requests are limited to localhost.");
        return;
      }
      response.writeHead(204, corsHeaders).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { ...corsHeaders, Allow: "GET, OPTIONS" }).end("Method not allowed");
      return;
    }
    const url = new URL(request.url || "/", "http://localhost");
    const operation = pathname === "/api/puzzles/status"
      ? puzzles.getStatus()
      : puzzles.getPage(
        Number(url.searchParams.get("offset") || 0),
        Number(url.searchParams.get("limit") || 16)
      );
    operation.then(payload => {
      if (!response.destroyed) {
        response.writeHead(200, {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }).end(JSON.stringify(payload));
      }
    }).catch(error => {
      if (response.destroyed) return;
      const badRequest = error instanceof RangeError;
      const unavailable = error.code === "ENOENT";
      response.writeHead(badRequest ? 400 : unavailable ? 404 : 500, {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }).end(JSON.stringify({ error: error.message }));
      if (!badRequest && !unavailable) console.error("Puzzle dataset request failed:", error);
    });
    return;
  }
  const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const file = resolve(root, `.${requested}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const stats = statSync(file);
    if (!stats.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Length": stats.size,
      "Content-Type": mimeTypes.get(extname(file).toLowerCase()) || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    createReadStream(file).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(500).end("Unable to serve file");
    console.error(error);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Nightfall Chess available at http://127.0.0.1:${port}`);
});