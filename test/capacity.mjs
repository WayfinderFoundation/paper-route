// Capacity maths: hand-checked cases. Offline. Run: node test/capacity.mjs
import { roundCapacity, bustDistance, HL_COST_FRACTION } from "../src/capacity.js";
import { sideRoomUsd } from "../src/papertrade.js";

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};
const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

const limits = { minMarginUsd: 10, minNotionalUsd: 10_000, maxLeverage: 1000, maxPositionNotionalUsd: 10_000_000, bustBuffer: 0.000476041580087574, openable: true };
const base = { ptLimits: { ...limits, sideRoomUsd: 250e6 }, hlMaxLeverage: 40, maxOrderUsd: 25_000, maxPositionUsd: 50_000 };

// 1. papertrade balance binds: $150 at 100x = $15,000 notional; HL has plenty
{
  const c = roundCapacity({ ...base, isPaperLong: true, ptLeverage: 100, hedge: true, ptAvailable: 150, hlAvailableToTrade: [5000, 5000], hlLeverage: 10 });
  check(near(c.maxNotional, 15_000) && c.maxMargin === 150 && c.binding === "papertrade balance", `paper balance binds: max $${c.maxMargin} margin / $${c.maxNotional} notional`);
  check(c.minMargin === 100, `min margin at 100x = $10,000 / 100 = $${c.minMargin}`);
}

// 2. HL margin binds: $1,200 free at 10x → 1200 / (0.1 + 0.001) = $11,881.18 notional → $118.81 margin at 100x
{
  const c = roundCapacity({ ...base, isPaperLong: true, ptLeverage: 100, hedge: true, ptAvailable: 1660, hlAvailableToTrade: [0, 1200], hlLeverage: 10 });
  const expected = 1200 / (0.1 + HL_COST_FRACTION);
  check(near(c.maxNotional, expected) && c.maxMargin === 118.81 && c.binding === "Hyperliquid margin", `HL binds: $${c.maxMargin} margin (expected 118.81), notional $${c.maxNotional.toFixed(2)}`);
}

// 3. side matters: paper long hedges with an HL SELL (index 1); buy-side room is irrelevant
{
  const long = roundCapacity({ ...base, isPaperLong: true, ptLeverage: 100, hedge: true, ptAvailable: 1660, hlAvailableToTrade: [9999, 1200], hlLeverage: 10 });
  const short = roundCapacity({ ...base, isPaperLong: false, ptLeverage: 100, hedge: true, ptAvailable: 1660, hlAvailableToTrade: [1200, 9999], hlLeverage: 10 });
  check(long.maxMargin === short.maxMargin && long.maxMargin === 118.81, "paper long uses HL sell room, paper short uses HL buy room");
}

// 4. not enough for papertrade's minimum notional → refused with the reason
{
  const c = roundCapacity({ ...base, isPaperLong: true, ptLeverage: 100, hedge: true, ptAvailable: 1660, hlAvailableToTrade: [500, 500], hlLeverage: 10 });
  // $500 free covers $10,000 only from 1 / (500/10000 − 0.001) ≈ 20.4x, so the fix is 40x
  check(!c.ok && /\$10,000 minimum/.test(c.problems[0]) && /Pick 40x/.test(c.problems[0]), `too small, with the fix: "${c.problems[0]}"`);
}

// 5. unhedged round ignores HL; user cap binds
{
  const c = roundCapacity({ ...base, maxOrderUsd: 12_000, isPaperLong: false, ptLeverage: 200, hedge: false, ptAvailable: 1660, hlAvailableToTrade: [0, 0], hlLeverage: 10 });
  check(c.maxMargin === 60 && c.binding === "your max order", `unhedged: user max order binds → $${c.maxMargin} at 200x`);
}

// 6. bust distance matches papertrade's ticket (100x → 0.952 %, 198x → 0.457 %)
check(near(bustDistance(100, limits.bustBuffer) * 100, 0.9524, 0.0001) && near(bustDistance(198, limits.bustBuffer) * 100, 0.4574, 0.0001), "bust distance = 1/lev − bust buffer");

// 7. papertrade OI room: cap below the net-OI bound, minus same-side OI (base units × 1e18)
{
  const e18 = 10n ** 18n;
  const l = { oi: { priceScale: "10", longOi: String(2n * e18), shortOi: "0", longCap: String(5n * e18), shortCap: String((1n << 128n) - 1n), maxNetOi: String(250_000_000n * e18) } };
  const roomLong = sideRoomUsd(l, true, 80_000); // cap 5 BTC − 2 BTC open = 3 BTC × $80k
  const roomShort = sideRoomUsd(l, false, 80_000); // unlimited cap → bounded by long OI + $250M net
  check(near(roomLong, 240_000, 1), `long room = (5 − 2) BTC × $80,000 = $${roomLong.toLocaleString()}`);
  check(near(roomShort, 250_000_000 + 160_000, 1), `short room = 2 BTC long OI + $250M net = $${roomShort.toLocaleString()}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
