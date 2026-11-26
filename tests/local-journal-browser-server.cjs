const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../public");

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
  if (url.pathname === "/api/sync") return json(response, 401, { error: "private journal requires credentials" });
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

server.listen(4178, "127.0.0.1", () => console.log("local journal QA server listening on 4178"));
