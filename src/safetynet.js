// Native safety net: one reduce-only trigger order on Hyperliquid per hedged papertrade position, at
// that position's bust (liquidation) price and for its size. Papertrade liquidates on its own, even
// with the browser closed; these make the hedge close at the same moment, so the pair never becomes
// one-sided when papertrade busts while nothing is watching.
//
// Pure planner: given what should be protected and the trigger orders Paper Route placed earlier,
// say what to keep, place and cancel. Orders the user placed themselves are never in `ours`.

// positions: [{ id, isLong, size, bust }] (papertrade, coin units);  hlSize: signed HL position
// ours: [{ oid, triggerPx, sz, closeIsBuy }] from Hyperliquid's open orders, filtered to oids we placed
export function planSafetyNet({ positions, hlSize, ours, roundSz, roundPx }) {
  const closeIsBuy = hlSize < 0;
  const desired = [];
  // only positions the HL leg actually hedges: paper long ↔ HL short, and only up to the HL size
  let left = Math.abs(hlSize);
  for (const p of positions) {
    if (hlSize === 0 || p.isLong !== closeIsBuy) continue;
    const sz = roundSz(Math.min(p.size, left));
    if (!(sz > 0)) continue;
    left -= sz;
    desired.push({ positionId: p.id, triggerPx: Number(roundPx(p.bust)), sz, closeIsBuy });
  }

  const unmatched = [...ours];
  const keep = [];
  const place = [];
  for (const d of desired) {
    const i = unmatched.findIndex((o) => o.closeIsBuy === d.closeIsBuy && Math.abs(o.triggerPx - d.triggerPx) < 1e-9 && Math.abs(o.sz - d.sz) < 1e-12);
    if (i >= 0) keep.push({ ...d, oid: unmatched.splice(i, 1)[0].oid });
    else place.push(d);
  }
  return { keep, place, cancel: unmatched.map((o) => o.oid) };
}
