// How big a matched round can be: the papertrade notional must fit papertrade (available
// balance × leverage, the side's open-interest cap, max position) AND the opposite HL hedge
// must fit Hyperliquid (availableToTrade on that side × HL leverage, after fees), AND the
// user's own caps. The smallest wins; that's the maximum on both sides.
// hedge-ui.js mirrors this formula for the live form; keep them in sync.

// HL taker 4.5 bp + Wayfinder builder 2 bp + slippage headroom, as a fraction of notional
export const HL_COST_FRACTION = 0.001;

export function roundCapacity({ isPaperLong, ptLeverage, hedge, ptAvailable, ptLimits, hlAvailableToTrade, hlLeverage, hlMaxLeverage, maxOrderUsd, maxPositionUsd }) {
  const parts = {
    "papertrade balance": ptAvailable * ptLeverage,
    // what papertrade will still accept on this side (OI caps / max net OI), from sideRoomUsd
    [`papertrade ${isPaperLong ? "long" : "short"} open-interest room`]: ptLimits.sideRoomUsd,
    "papertrade max position": ptLimits.maxPositionNotionalUsd,
    "your max order": maxOrderUsd,
    "your max hedge position": maxPositionUsd,
  };
  if (hedge) {
    // the hedge trades the opposite side: paper long → HL sell (index 1), paper short → HL buy (index 0)
    const free = hlAvailableToTrade[isPaperLong ? 1 : 0];
    parts["Hyperliquid margin"] = free / (1 / hlLeverage + HL_COST_FRACTION);
  }
  let binding = null;
  let maxNotional = Infinity;
  for (const [name, v] of Object.entries(parts)) {
    if (v < maxNotional) {
      maxNotional = v;
      binding = name;
    }
  }
  maxNotional = Math.max(0, maxNotional);
  const maxMargin = Math.floor((maxNotional / ptLeverage) * 100) / 100;
  const minMargin = Math.ceil(Math.max(ptLimits.minMarginUsd, ptLimits.minNotionalUsd / ptLeverage) * 100) / 100;

  const problems = [];
  if (ptLeverage > ptLimits.maxLeverage) problems.push(`Papertrade max leverage is ${ptLimits.maxLeverage}x`);
  if (hedge && hlLeverage > hlMaxLeverage) problems.push(`Hyperliquid max leverage is ${hlMaxLeverage}x`);
  if (!ptLimits.openable) problems.push("Papertrade isn't accepting new positions right now");
  if (maxMargin < minMargin) {
    problems.push(`Needs ≥ $${minMargin} margin ($${Math.round(ptLimits.minNotionalUsd).toLocaleString()} min notional) but max is $${maxMargin} (limited by ${binding})`);
  }
  return { maxMargin, minMargin, maxNotional, binding, parts, problems, ok: problems.length === 0 };
}

// papertrade busts at entry × (1 ∓ (1/leverage − bustBuffer))
export function bustDistance(ptLeverage, bustBuffer) {
  return 1 / ptLeverage - bustBuffer;
}
