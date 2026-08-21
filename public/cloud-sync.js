(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TradingCloudSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_CAPITAL = 100000;

  function timestamp(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  }

  function normalizeDeletedTrades(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.fromEntries(Object.entries(source)
      .map(([tradeId, deletedAt]) => [String(tradeId), timestamp(deletedAt)])
      .filter(([tradeId, deletedAt]) => tradeId && deletedAt > 0));
  }

  function tradeTimestamp(trade) {
    return timestamp(trade?.updatedAt,
      timestamp(trade?.closeAt, timestamp(trade?.openAt, 1)));
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" ? value : {};
    const capital = Number(source.capital);
    const trades = Array.isArray(source.trades) ? source.trades
      .filter((trade) => trade && typeof trade === "object" && trade.id)
      .map((trade) => ({ ...trade, id: String(trade.id), updatedAt: tradeTimestamp(trade) })) : [];
    return {
      capital: Number.isFinite(capital) && capital > 0 ? capital : DEFAULT_CAPITAL,
      capitalUpdatedAt: timestamp(source.capitalUpdatedAt),
      trades,
      deletedTrades: normalizeDeletedTrades(source.deletedTrades)
    };
  }

  function mergeStates(localValue, remoteValue) {
    const local = normalizeState(localValue);
    const remote = normalizeState(remoteValue);
    const deletedTrades = { ...remote.deletedTrades };
    for (const [tradeId, deletedAt] of Object.entries(local.deletedTrades)) {
      deletedTrades[tradeId] = Math.max(deletedTrades[tradeId] || 0, deletedAt);
    }

    const candidates = new Map();
    for (const trade of [...remote.trades, ...local.trades]) {
      const current = candidates.get(trade.id);
      if (!current || tradeTimestamp(trade) >= tradeTimestamp(current)) candidates.set(trade.id, trade);
    }

    const trades = [...candidates.values()]
      .filter((trade) => (deletedTrades[trade.id] || 0) < tradeTimestamp(trade))
      .sort((left, right) => tradeTimestamp(right) - tradeTimestamp(left));
    const useLocalCapital = local.capitalUpdatedAt > remote.capitalUpdatedAt;
    return {
      capital: useLocalCapital ? local.capital : remote.capital,
      capitalUpdatedAt: Math.max(local.capitalUpdatedAt, remote.capitalUpdatedAt),
      trades,
      deletedTrades
    };
  }

  function stableState(value) {
    const normalized = normalizeState(value);
    return JSON.stringify({
      capital: normalized.capital,
      capitalUpdatedAt: normalized.capitalUpdatedAt,
      trades: [...normalized.trades]
        .map(({ lastPrice, lastPriceAt, ...trade }) => trade)
        .sort((left, right) => left.id.localeCompare(right.id)),
      deletedTrades: Object.fromEntries(Object.entries(normalized.deletedTrades).sort(([left], [right]) => left.localeCompare(right)))
    });
  }

  function statesEqual(left, right) {
    return stableState(left) === stableState(right);
  }

  return { DEFAULT_CAPITAL, normalizeState, mergeStates, statesEqual, tradeTimestamp };
});
