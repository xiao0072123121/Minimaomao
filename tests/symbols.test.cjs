const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (filename) => fs.readFileSync(path.join(root, filename), "utf8");

test("BTCUSDT is available in monitoring, trading forms, and the Worker proxy", () => {
  const html = read("public/index.html");
  const market = read("public/binance-xau.js");
  const worker = read("src/worker.js");

  assert.match(html, /data-symbol="BTCUSDT"[^>]*>比特币 · BTCUSDT</);
  assert.equal((html.match(/<option>BTCUSDT<\/option>/g) || []).length, 2);
  assert.match(market, /BTCUSDT:\s*\{\s*label:\s*"比特币",\s*base:\s*"BTC"\s*\}/);
  assert.match(worker, /BINANCE_SYMBOLS[^\n]*"BTCUSDT"/);
});
