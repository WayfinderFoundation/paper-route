// Safety-net planner: which liquidation-price triggers should rest on Hyperliquid. Run: node test/safetynet.mjs
import { planSafetyNet } from "../src/safetynet.js";
import { roundPrice, roundSize } from "../src/hl.js";

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};
const roundSz = (v) => roundSize(v, 5);
const roundPx = (v) => roundPrice(v, 5);
const plan = (positions, hlSize, ours = []) => planSafetyNet({ positions, hlSize, ours, roundSz, roundPx });

// paper long 0.12 BTC busts at 81,800; HL short 0.12 hedges it → one buy-to-close trigger at the bust
{
  const p = plan([{ id: "1", isLong: true, size: 0.12, bust: 81_800.37 }], -0.12);
  check(p.place.length === 1 && p.place[0].closeIsBuy && p.place[0].triggerPx === 81_800 && p.place[0].sz === 0.12, "one trigger at the bust price, buy-to-close, full size");
  check(p.cancel.length === 0 && p.keep.length === 0, "nothing to keep or cancel on the first run");
}

// already resting and unchanged → keep, place nothing
{
  const p = plan([{ id: "1", isLong: true, size: 0.12, bust: 81_800.37 }], -0.12, [{ oid: 7, triggerPx: 81_800, sz: 0.12, closeIsBuy: true }]);
  check(p.keep.length === 1 && p.keep[0].oid === 7 && !p.place.length && !p.cancel.length, "an existing matching trigger is kept, not re-placed");
}

// position resized → old trigger cancelled, new one placed
{
  const p = plan([{ id: "1", isLong: true, size: 0.2, bust: 81_800.37 }], -0.2, [{ oid: 7, triggerPx: 81_800, sz: 0.12, closeIsBuy: true }]);
  check(p.cancel[0] === 7 && p.place[0].sz === 0.2, "size changed → cancel and re-place");
}

// two positions, HL hedges only part → triggers never exceed the HL size
{
  const p = plan(
    [
      { id: "1", isLong: false, size: 0.1, bust: 83_000 },
      { id: "2", isLong: false, size: 0.1, bust: 83_400 },
    ],
    0.15,
  );
  const total = p.place.reduce((a, d) => a + d.sz, 0);
  check(p.place.length === 2 && Math.abs(total - 0.15) < 1e-12 && p.place.every((d) => !d.closeIsBuy), "paper shorts → sell-to-close triggers, capped at the HL size");
}

// HL flat, or HL on the same side as paper (not a hedge) → nothing rests; leftovers are cancelled
{
  const flat = plan([{ id: "1", isLong: true, size: 0.1, bust: 81_000 }], 0, [{ oid: 9, triggerPx: 81_000, sz: 0.1, closeIsBuy: true }]);
  check(!flat.place.length && flat.cancel[0] === 9, "HL flat → cancel the old trigger");
  const sameSide = plan([{ id: "1", isLong: true, size: 0.1, bust: 81_000 }], 0.1);
  check(!sameSide.place.length, "HL long next to a paper long isn't a hedge → no trigger");
  const closed = plan([], -0.1, [{ oid: 3, triggerPx: 81_000, sz: 0.1, closeIsBuy: true }]);
  check(!closed.place.length && closed.cancel[0] === 3, "papertrade position gone → its trigger is cancelled");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
