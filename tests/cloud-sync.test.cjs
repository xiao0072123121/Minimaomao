const assert = require("node:assert/strict");
const { normalizeState, mergeStates, statesEqual } = require("../public/cloud-sync.js");

const trade = (id, updatedAt, overrides = {}) => ({
  id, updatedAt, symbol: "XAUUSDT", side: "long", status: "open", closed: false,
  openAt: updatedAt - 100, entryPrice: 4500, quantity: 0.5, leverage: 20,
  ...overrides
});

{
  const local = { capital: 120000, capitalUpdatedAt: 200, trades: [trade("local", 300)], deletedTrades: {} };
  const remote = { capital: 100000, capitalUpdatedAt: 100, trades: [trade("remote", 250)], deletedTrades: {} };
  const merged = mergeStates(local, remote);
  assert.equal(merged.capital, 120000, "newer local capital must win");
  assert.deepEqual(merged.trades.map((item) => item.id), ["local", "remote"], "independent device trades must be preserved");
}

{
  const older = trade("same", 100, { note: "old" });
  const newer = trade("same", 200, { note: "new" });
  const merged = mergeStates({ trades: [older] }, { trades: [newer] });
  assert.equal(merged.trades[0].note, "new", "newest edit must win per trade");
}

{
  const merged = mergeStates(
    { trades: [], deletedTrades: { deleted: 300 } },
    { trades: [trade("deleted", 200)], deletedTrades: {} }
  );
  assert.equal(merged.trades.length, 0, "a newer deletion tombstone must prevent a deleted trade from reappearing");
  assert.equal(merged.deletedTrades.deleted, 300);
}

{
  const normalized = normalizeState({ capital: "150000", trades: [trade("legacy", 0, { updatedAt: undefined, openAt: 123 })] });
  assert.equal(normalized.capital, 150000);
  assert.equal(normalized.trades[0].updatedAt, 123, "legacy trades must receive a deterministic timestamp");
  assert.ok(statesEqual(normalized, JSON.parse(JSON.stringify(normalized))), "stable equality must ignore object identity");
  assert.ok(statesEqual(
    { ...normalized, trades: [{ ...normalized.trades[0], lastPrice: 4510, lastPriceAt: 500 }] },
    { ...normalized, trades: [{ ...normalized.trades[0], lastPrice: 4520, lastPriceAt: 600 }] }
  ), "live quote fields must not trigger cloud writes");
}

console.log("cloud-sync tests passed");
