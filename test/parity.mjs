// Parity with the fit: 20 minutes of recorded 100 ms ticks (BTC, Hyperliquid), from the start of a feed
// segment, fed through the browser engine must reproduce the features and the quick / full model forecasts
// computed when the index was fitted. Fixture values are rounded to 7 significant digits.
// Run: node test/parity.mjs
import { readFileSync } from "node:fs";
import { createFlowEngine, scoreIndex } from "../src/flowindex.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/flowindex-parity.json", import.meta.url), "utf8"));
const W = JSON.parse(readFileSync(new URL("../src/index-weights.json", import.meta.url), "utf8"))[fx.coin];

// relative tolerance (inputs are rounded to 7 significant digits; 60 s OFI sums of rounded sizes lose ~1e-5)
const TOL = 2e-3;
const ABS = 1e-6;

const engine = createFlowEngine();
const expected = new Map(fx.expected.map((r) => [r[0], r]));
const cols = fx.expected_columns;
let checked = 0;
let failures = 0;
const worst = {};
const tiers = { quick: 0, full: 0, none: 0 };

function check(c, a, b, ts) {
  if (b === null) {
    if (Number.isFinite(a)) {
      if (failures < 8) console.log(`✗ ${c} @ ${ts}: got ${a}, want undefined`);
      failures++;
    }
    return;
  }
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1e-3);
  worst[c] = Math.max(worst[c] ?? 0, Number.isFinite(err) ? err : Infinity);
  if (!(Math.abs(a - b) <= ABS || err <= TOL)) {
    if (failures < 8) console.log(`✗ ${c} @ ${ts}: got ${a}, want ${b}`);
    failures++;
  }
}

for (const raw of fx.raw) {
  const r = Object.fromEntries(fx.raw_columns.map((c, i) => [c, raw[i]]));
  const row = {
    ts: r.ts_ms,
    mid: (r.bid_px + r.ask_px) / 2,
    bid_px: r.bid_px,
    ask_px: r.ask_px,
    bid_sz: r.bid_sz,
    ask_sz: r.ask_sz,
    imb10: (r.sb10 - r.sa10) / (r.sb10 + r.sa10),
    depth_bid_5: r.sb5,
    depth_ask_5: r.sa5,
    mark: r.mark ?? NaN,
    oracle: r.oracle ?? NaN,
    funding: r.funding ?? NaN,
    oi: r.oi ?? NaN,
    buy_sz: r.buy_sz,
    sell_sz: r.sell_sz,
    trade_count: r.trade_count,
  };
  const out = engine.step(row, r.observed);
  const want = expected.get(r.ts_ms);
  if (!want) continue;
  const idx = scoreIndex(out.x, W);
  tiers[idx?.model ?? "none"]++;
  cols.forEach((c, i) => {
    if (c === "ts_ms") return;
    const m = c.match(/^(quick|full)_(\d+)s_bp$/);
    if (!m) return check(c, out.x[c], want[i], r.ts_ms);
    // each tier's forecast is checked whenever the fit had all of that tier's features
    const [, tier, h] = m;
    const model = W.models[tier];
    const ready = model.features.every((f) => Number.isFinite(out.x[f]));
    const got = ready ? scoreIndex(out.x, { models: { [tier]: model } }).horizons.find((x) => x.s === Number(h)).ret_bps : NaN;
    check(c, got, want[i], r.ts_ms);
  });
  checked++;
}

for (const [c, e] of Object.entries(worst)) console.log(`${e <= TOL ? "✓" : "✗"} ${c.padEnd(16)} worst rel err ${e.toExponential(1)}`);
console.log(`model used per 1 s row: quick ${tiers.quick}, full ${tiers.full}, none ${tiers.none}`);
if (!(tiers.none > 0 && tiers.none <= 11 && tiers.quick > 0 && tiers.quick <= 61)) {
  console.log("✗ expected ~10 s with no forecast, then the quick model until 60 s, then the full model");
  failures++;
}
console.log(checked === fx.expected.length ? `✓ checked all ${checked} expected rows` : `✗ only ${checked} of ${fx.expected.length} rows matched a timestamp`);
if (checked !== fx.expected.length) failures++;
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
