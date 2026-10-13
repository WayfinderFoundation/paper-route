// Parity with the fit: 20 minutes of recorded 100 ms rows (BTC, Hyperliquid) fed through the
// browser engine must reproduce the features and index values computed when the index was fitted. Fixture values are rounded to 7 significant digits. Run: node test/parity.mjs
import { readFileSync } from "node:fs";
import { createFlowEngine, scoreIndex } from "../src/flowindex.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/flowindex-parity.json", import.meta.url), "utf8"));
const W = JSON.parse(readFileSync(new URL("../src/index-weights.json", import.meta.url), "utf8"))[fx.coin];

// relative tolerance per column (rounded inputs: OFI sums ~1e-4, OI log-differences ~1e-2)
const TOL = { oi_signed_300s: 2e-2, default: 2e-3 };
const ABS = 1e-6;

const engine = createFlowEngine();
const expected = new Map(fx.expected.map((r) => [r[0], r]));
const cols = fx.expected_columns;
let checked = 0;
const worst = {};
let failures = 0;

for (const raw of fx.raw) {
  const row = Object.fromEntries(fx.raw_columns.map((c, i) => [c, raw[i]]));
  row.ts = row.ts_ms;
  const out = engine.step(row);
  const want = expected.get(row.ts_ms);
  if (!want) continue;
  const idx = scoreIndex(out.x, W);
  const got = { ...out.x };
  for (const h of idx.horizons) {
    got[`pred_${h.s}s_bp`] = h.ret_bps;
    got[`index_${h.s}s`] = h.score;
  }
  cols.forEach((c, i) => {
    if (c === "ts_ms") return;
    const a = got[c];
    const b = want[i];
    if (b === null || Number.isNaN(b)) return;
    const err = Math.abs(a - b) / Math.max(Math.abs(b), 1e-3);
    worst[c] = Math.max(worst[c] ?? 0, Number.isFinite(err) ? err : Infinity);
    if (!(Math.abs(a - b) <= ABS || err <= (TOL[c] ?? TOL.default))) {
      if (failures < 8) console.log(`✗ ${c} @ ${row.ts_ms}: got ${a}, want ${b}`);
      failures++;
    }
  });
  checked++;
}

for (const [c, e] of Object.entries(worst)) console.log(`${e <= (TOL[c] ?? TOL.default) ? "✓" : "✗"} ${c.padEnd(16)} worst rel err ${e.toExponential(1)}`);
console.log(checked === fx.expected.length ? `✓ checked all ${checked} expected rows` : `✗ only ${checked} of ${fx.expected.length} rows matched a timestamp`);
if (checked !== fx.expected.length) failures++;
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
