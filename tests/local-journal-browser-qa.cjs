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
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.JOURNAL_QA_CHROMIUM,
    args: ["--disable-gpu", "--renderer-process-limit=1", "--js-flags=--max-old-space-size=256"]
  });
  try {
    const syncRequests = [];
    async function newDevice(viewport) {
      const device = await browser.newContext({ viewport });
      const page = await device.newPage();
      await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await page.routeWebSocket("**/*", () => {});
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/sync") syncRequests.push(request.method());
      });
      return { device, page };
    }

    const deviceA = await newDevice({ width: 1440, height: 960 });
    await seedLocal(deviceA.page);
    await deviceA.page.goto(`${base}/#journal`);
    await deviceA.page.locator(`[data-edit-trade="${seedTrade.id}"]`).waitFor();
    await deviceA.page.reload();
    await deviceA.page.locator(`[data-edit-trade="${seedTrade.id}"]`).waitFor();
    assert.equal(await deviceA.page.evaluate(() => window.paperTrading.getSimulationSnapshot().capital), 125000);
    await deviceA.device.close();

    const deviceB = await newDevice({ width: 390, height: 844 });
    await deviceB.page.goto(`${base}/#simulation`);
    await deviceB.page.locator("#view-simulation.active").waitFor();
    assert.equal(await deviceB.page.locator(".simulation-storage").innerText(), "记录保存在此浏览器");
    const snapshot = await deviceB.page.evaluate(() => window.paperTrading.getSimulationSnapshot());
    assert.deepEqual(snapshot, { capital: 100000, trades: [] }, "fresh devices must not inherit another browser's journal");
    assert.deepEqual(syncRequests, [], "the browser must not contact the retired sync endpoint");
    await deviceB.device.close();
    console.log("local journal browser QA passed");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
