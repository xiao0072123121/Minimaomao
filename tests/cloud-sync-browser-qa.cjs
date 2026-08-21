const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const base = "http://127.0.0.1:4178";
const seedTrade = {
  id: "device-a-trade", symbol: "XAUUSDT", side: "long", status: "closed", closed: true,
  openAt: 1787281200000, closeAt: 1787284800000, entryPrice: 4500, closePrice: 4510,
  quantity: 0.5, remainingQuantity: 0, leverage: 20, stopLoss: 4490, takeProfit: 4510,
  pnl: 100, lastPrice: 4510, lastPriceAt: 1787284800000, exitReason: "止盈",
  reasons: ["支撑/压力"], note: "device A migration", includeInAnalysis: true, updatedAt: 1787284800000
};

async function seedLocal(page) {
  await page.goto(`${base}/blank`);
  await page.evaluate(async (trade) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("paper-trading-journal", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "key" });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("records", "readwrite");
        transaction.objectStore("records").put({
          key: "simulation-account",
          value: { capital: 125000, capitalUpdatedAt: 1787284900000, trades: [trade], deletedTrades: {} },
          savedAt: 1787284900000
        });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, seedTrade);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const deviceA = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const pageA = await deviceA.newPage();
  await seedLocal(pageA);
  await pageA.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await pageA.waitForFunction(() => document.querySelector("#cloud-sync-status")?.textContent.includes("云端已同步"));
  const cloud = await (await fetch(`${base}/__test_state`)).json();
  assert.equal(cloud.state.capital, 125000, "device A capital must migrate to cloud");
  assert.equal(cloud.state.trades[0].id, seedTrade.id, "device A trade must migrate to cloud");

  const deviceB = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const pageB = await deviceB.newPage();
  await pageB.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await pageB.waitForFunction(() => window.paperTrading?.getSimulationSnapshot?.().trades?.some((trade) => trade.id === "device-a-trade"));
  const snapshotB = await pageB.evaluate(() => window.paperTrading.getSimulationSnapshot());
  assert.equal(snapshotB.capital, 125000, "device B must download cloud capital");
  assert.equal(snapshotB.trades.length, 1, "device B must download cloud trades");
  await pageB.click('[data-view="simulation"]');
  await pageB.screenshot({ path: "/tmp/minimaomao-cloud-sync-desktop.png", fullPage: true });

  await deviceA.close();
  await deviceB.close();
  await browser.close();
  console.log("cloud-sync browser QA passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
