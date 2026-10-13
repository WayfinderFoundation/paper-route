// Feature engine on hand-built books and trades (formula parity with the fit is in
// parity.mjs). Run: node test/flowindex.mjs
import { createFlowEngine, regimeOf, rowFromBook, scoreIndex } from "../src/flowindex.js";

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const book = (bid, bidSz, ask, askSz, deeper = []) => ({
  bids: [[bid, bidSz], ...deeper.map(([p, s]) => [bid - p, s])],
  asks: [[ask, askSz], ...deeper.map(([p, s]) => [ask + p, s])],
});
const ctx = { markPx: 100.6, oraclePx: 100.4, funding: 0.0000125, openInterest: 1000 };
const row = (ts, b, trades = [], c = ctx) => rowFromBook({ ts, book: b, trades, ctx: c });

// ---------- row from an l2Book snapshot ----------
{
  const r = row(0, book(100, 3, 101, 1, [[1, 1], [2, 1], [3, 1], [4, 1], [5, 9], [6, 9], [7, 9], [8, 9], [9, 9], [10, 9]]), [
    { isBuy: true, sz: 2 },
    { isBuy: false, sz: 0.5 },
  ]);
  check(near(r.mid, 100.5), "mid = (bid + ask) / 2");
  check(near(r.imb1, 0.5) && r.depth_bid_5 === 7 && r.depth_ask_5 === 5, "L1 imbalance and top-5 depth sums");
  check(near(r.imb10, (3 + 4 + 45 - (1 + 4 + 45)) / (52 + 50)), "imb10 uses only the first ten levels");
  check(r.buy_sz === 2 && r.sell_sz === 0.5 && r.trade_count === 2, "taker buys / sells / count for the bucket");
}

// ---------- first tick: instantaneous features only ----------
{
  const e = createFlowEngine();
  const { x } = e.step(row(0, book(100, 3, 101, 1, [[1, 1], [2, 1], [3, 1], [4, 1]])));
  check(near(x.micro_bps, Math.log(((101 * 3 + 100 * 1) / 4) / 100.5) * 1e4), "microprice leans toward the thin side");
  check(near(x.imb5, 2 / 12), "imb5 from the depth sums");
  check(Number.isNaN(x.ofi_1s) && Number.isNaN(x.flowz_5s) && Number.isNaN(x.ret_5s), "rolling features undefined until their window is full");
  check(near(x.mark_mid_bps, Math.log(100.6 / 100.5) * 1e4) && near(x.funding_bps, 0.125), "mark vs mid, funding in bp");
}

// ---------- OFI: a rising bid is buying pressure ----------
{
  const e = createFlowEngine();
  let out;
  for (let i = 0; i < 600; i++) out = e.step(row(i * 100, book(100 + (i === 599 ? 0.5 : 0), 2, 101, 2)));
  check(near(out.x.ofi_1s, 2 / 4), `bid steps up → OFI = new bid size / mean depth (${out.x.ofi_1s.toFixed(3)})`);
}

// ---------- taker flow z-score needs 10 minutes, then has the flow's sign ----------
{
  const e = createFlowEngine();
  let out;
  for (let i = 0; i < 6060; i++) out = e.step(row(i * 100, book(100, 1, 101, 1), [{ isBuy: i % 3 === 0, sz: 1 }]));
  check(Number.isFinite(out.x.flowz_5s) && out.x.flowz_5s < 0, `net selling → negative flowz_5s (${out.x.flowz_5s.toFixed(2)})`);
  check(out.warm === true, "warm once flowz and the 10-minute vol are defined");
}

// ---------- returns and OI over 300 s ----------
{
  const e = createFlowEngine();
  let out;
  for (let i = 0; i <= 3000; i++) {
    const mid = 100 + i * 0.001;
    out = e.step(row(i * 100, book(mid - 0.5, 1, mid + 0.5, 1), [], { ...ctx, openInterest: 1000 + i }));
  }
  check(near(out.x.ret_300s, Math.log(103 / 100) * 1e4, 1e-6), "ret_300s over 3000 rows");
  check(near(out.x.oi_signed_300s, Math.log(4000 / 1000) * 1e4, 1e-6), "OI change over 300 s, signed by the price move");
  check(Number.isFinite(out.x.vol_60s) && Number.isNaN(out.x.vol_600s), "vol_60s defined, vol_600s still filling");
}

// ---------- more than 2 s without a book update starts a new segment ----------
{
  const e = createFlowEngine();
  for (let i = 0; i < 100; i++) e.step(row(i * 100, book(100, 1, 101, 1)));
  check(e.step(row(12_400, book(100, 1, 101, 1)), false) === null, "unobserved bucket 2.5 s after the last book → no features");
  const out = e.step(row(13_000, book(100, 1, 101, 1)));
  check(Number.isNaN(out.x.ret_5s), "after the gap, windows start over");
}

// ---------- index: standardise, weight, clip; regime ----------
{
  const w = {
    features: ["imb1", "flowz_5s"],
    mean: [0, 0],
    std: [0.5, 2],
    horizons: { 10: { coef: [0.2, 0.1], intercept: 0, scale: 0.2 }, 30: { coef: [0.4, 0.2], intercept: 0, scale: 0.4, show: false } },
    regimes: { vol600: [0.3, 0.6] },
  };
  const r = scoreIndex({ imb1: 0.5, flowz_5s: 2 }, w);
  check(near(r.horizons[0].ret_bps, 0.3), "expected move = Σ coef · z");
  check(near(r.score, 75), "index = 50 · move / scale");
  check(r.lead === 10, "lead horizon is the first shown one");
  check(scoreIndex({ imb1: 50, flowz_5s: 0 }, w).score === 100, "index clipped at +100");
  check(scoreIndex({ imb1: NaN, flowz_5s: 0 }, w).horizons[0].ret_bps === 0, "an undefined feature contributes nothing");
  check(regimeOf(0.2, w) === "calm" && regimeOf(0.5, w) === "normal" && regimeOf(0.9, w) === "wild", "vol regimes from the cut points");
  check(regimeOf(0.5, {}) === null, "no cut points → no regime label");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
