(function attachLiquidationCalculator(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinanceLiquidationCalculator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  // Binance applies symbol- and notional-specific maintenance-margin brackets.
  // The public simulation has no signed Binance account access, so it uses the
  // 0.65% reference rate shown in Binance's official bracket documentation.
  const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.0065;

  function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function estimateIsolatedLiquidation(options = {}) {
    const entryPrice = positiveNumber(options.entryPrice);
    const leverage = positiveNumber(options.leverage);
    const quantity = positiveNumber(options.quantity);
    const side = options.side === "short" ? "short" : options.side === "long" ? "long" : null;
    const maintenanceMarginRate = Number.isFinite(Number(options.maintenanceMarginRate))
      ? Number(options.maintenanceMarginRate)
      : DEFAULT_MAINTENANCE_MARGIN_RATE;
    const maintenanceAmount = Math.max(0, Number(options.maintenanceAmount) || 0);
    const extraMargin = Math.max(0, Number(options.extraMargin) || 0);

    if (!entryPrice || !leverage || !quantity || !side || maintenanceMarginRate < 0 || maintenanceMarginRate >= 1) return null;

    // In this simulator quantity is the margin-funded base quantity. Effective
    // futures exposure is quantity × leverage, matching the existing PnL model.
    const exposureQuantity = quantity * leverage;
    const entryNotional = entryPrice * exposureQuantity;
    const isolatedMargin = entryPrice * quantity + extraMargin;
    const denominator = exposureQuantity * (side === "long"
      ? 1 - maintenanceMarginRate
      : 1 + maintenanceMarginRate);
    const numerator = side === "long"
      ? entryNotional - isolatedMargin - maintenanceAmount
      : entryNotional + isolatedMargin + maintenanceAmount;
    const price = numerator / denominator;

    if (!Number.isFinite(price) || price < 0) return null;
    return {
      price,
      side,
      entryNotional,
      isolatedMargin,
      exposureQuantity,
      maintenanceMarginRate,
      maintenanceAmount
    };
  }

  function distanceFromMark(markPrice, liquidationPrice, side) {
    const mark = positiveNumber(markPrice);
    const liquidation = positiveNumber(liquidationPrice);
    if (!mark || !liquidation || (side !== "long" && side !== "short")) return null;
    const distance = side === "long" ? mark - liquidation : liquidation - mark;
    return distance / mark * 100;
  }

  return {
    DEFAULT_MAINTENANCE_MARGIN_RATE,
    estimateIsolatedLiquidation,
    distanceFromMark
  };
});
