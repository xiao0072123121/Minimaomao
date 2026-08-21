const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../public");
let revision = 0;
let state = { capital: 100000, capitalUpdatedAt: 0, trades: [], deletedTrades: {} };

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const json = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/blank") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return response.end("<!doctype html><title>seed</title>");
  }
  if (url.pathname === "/__test_state") return json(response, 200, { revision, state });
  if (url.pathname === "/api/sync" && request.method === "GET") return json(response, 200, { revision, updatedAt: Date.now(), state });
  if (url.pathname === "/api/sync" && request.method === "PUT") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    return request.on("end", () => {
      const incoming = JSON.parse(body);
      if (incoming.revision !== revision) return json(response, 409, { error: "conflict", revision, state });
      state = incoming.state;
      revision += 1;
      return json(response, 200, { revision, updatedAt: Date.now() });
    });
  }
  if (url.pathname.startsWith("/api/binance/")) return json(response, 503, { msg: "disabled in QA" });

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filename = path.resolve(root, `.${requested}`);
  if (!filename.startsWith(root) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    response.writeHead(404);
    return response.end("not found");
  }
  response.writeHead(200, { "Content-Type": types[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(filename).pipe(response);
});

server.listen(4178, "127.0.0.1", () => console.log("cloud sync QA server listening on 4178"));
