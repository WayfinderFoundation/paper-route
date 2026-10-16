// Delta-neutral pairs on papertrade itself: a papertrade position (the main leg) and an opposite papertrade
// position opened with it (the hedge leg). Paper Route places the hedge leg from the order ticket right
// after the main order (both go into papertrade's queue together); this module recognises the two legs when
// they fill, remembers which belong together, and closes them together.
//
// Auto close (per coin, on by default): when one leg closes for any reason (its stop loss / take profit, a
// manual close, a liquidation), the other is closed too, so a leg is never left on its own. With it off,
// the other leg is left to run.

const TICK_MS = 1_000;
const CLOSE_RESEND_MS = 6_000;
const CLOSE_ALERT_MS = 45_000;
const PENDING_TTL_MS = 10 * 60_000; // without a queued open on that coin
const PENDING_MAX_MS = 2 * 60 * 60_000;
const MATCH_SLACK_MS = 5_000;
const DONE_KEEP_MS = 60_000;

// ctx: { positions(): [{ id, coin, isLong, openedAtMs }] (every coin it can read),
//        readableCoins(): coins whose positions() is complete, openQueued(coin, isLong), closeQueued(id),
//        ptLive(), autoClose(coin), exec(action, args), alert(level, text), emit(), onDone?({ coin, ids, openedAt }) }
export function createPairs(ctx) {
  let pairs = {}; // mainId → { coin, mainIsLong, hedgeId, state: "open" | "closing" | "done", closing: { id → { sentAt, since } }, reason }
  let pending = []; // [{ coin, mainIsLong, at, knownIds, mainId, hedgeId }]
  let timer = null;
  let stepping = false;

  async function load() {
    const saved = await chrome.storage.local.get(["ptPairs", "ptPairsPending"]);
    pairs = saved.ptPairs ?? {};
    pending = saved.ptPairsPending ?? [];
  }
  const save = () => chrome.storage.local.set({ ptPairs: pairs, ptPairsPending: pending });

  function ensureRunning() {
    const active = pending.length || Object.values(pairs).some((p) => p.state !== "done");
    if (active && !timer) timer = setInterval(tick, TICK_MS);
    if (!active && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  const partnerOf = (id) => {
    for (const [mainId, p] of Object.entries(pairs)) {
      if (p.state === "done") continue;
      if (mainId === id) return { pair: p, mainId, other: p.hedgeId };
      if (p.hedgeId === id) return { pair: p, mainId, other: mainId };
    }
    return null;
  };

  // the order ticket placed (or is placing) a main order and its hedge: pair the next two fills
  function arm({ coin, mainIsLong }) {
    const knownIds = ctx.positions().filter((p) => p.coin === coin).map((p) => p.id);
    pending.push({ coin, mainIsLong, at: Date.now(), knownIds, mainId: null, hedgeId: null });
    save();
    ensureRunning();
    ctx.emit();
  }

  function attach(positions) {
    const taken = new Set(Object.entries(pairs).flatMap(([m, p]) => [m, p.hedgeId]));
    for (const pp of pending) for (const id of [pp.mainId, pp.hedgeId]) if (id) taken.add(id);
    let changed = false;
    for (const pp of [...pending]) {
      const fresh = (isLong) =>
        positions.find((p) => p.coin === pp.coin && p.isLong === isLong && !pp.knownIds.includes(p.id) && !taken.has(p.id) && p.openedAtMs >= pp.at - MATCH_SLACK_MS);
      if (!pp.mainId) {
        const m = fresh(pp.mainIsLong);
        if (m) {
          pp.mainId = m.id;
          taken.add(m.id);
          changed = true;
        }
      }
      if (!pp.hedgeId) {
        const h = fresh(!pp.mainIsLong);
        if (h) {
          pp.hedgeId = h.id;
          taken.add(h.id);
          changed = true;
        }
      }
      if (pp.mainId && pp.hedgeId) {
        pairs[pp.mainId] = { coin: pp.coin, mainIsLong: pp.mainIsLong, hedgeId: pp.hedgeId, state: "open", closing: {}, openedAt: pp.at };
        pending.splice(pending.indexOf(pp), 1);
        ctx.alert("ok", `Delta-neutral pair open on papertrade: ${pp.coin} ${pp.mainIsLong ? "long" : "short"} ${pp.mainId} ↔ ${pp.mainIsLong ? "short" : "long"} ${pp.hedgeId}`);
        changed = true;
        continue;
      }
      const age = Date.now() - pp.at;
      const stillQueued = ctx.openQueued(pp.coin, pp.mainIsLong) || ctx.openQueued(pp.coin, !pp.mainIsLong);
      if (age > PENDING_MAX_MS || (age > PENDING_TTL_MS && !stillQueued)) {
        pending.splice(pending.indexOf(pp), 1);
        const only = pp.mainId ?? pp.hedgeId;
        ctx.alert("warn", only
          ? `Only one leg of the ${pp.coin} delta-neutral pair filled (position ${only}); it's open on its own`
          : `The ${pp.coin} delta-neutral orders never filled on papertrade`);
        changed = true;
      }
    }
    return changed;
  }

  // start closing `ids` of a pair; the tick keeps clicking until each is gone
  function startClosing(mainId, ids, reason) {
    const p = pairs[mainId];
    if (!p) return;
    p.state = "closing";
    p.reason ??= reason;
    for (const id of ids) p.closing[id] ??= { sentAt: 0, since: Date.now() };
  }

  async function tick() {
    if (stepping) return;
    stepping = true;
    try {
      if (!ctx.ptLive()) return;
      const positions = ctx.positions();
      const open = new Set(positions.map((p) => p.id));
      const readable = new Set(ctx.readableCoins());
      let changed = attach(positions);
      for (const [mainId, p] of Object.entries(pairs)) {
        if (p.state === "done" || !readable.has(p.coin)) continue;
        const legs = [mainId, p.hedgeId];
        const gone = legs.filter((id) => !open.has(id));
        if (gone.length === 2) {
          p.state = "done";
          p.doneAt = Date.now();
          if (p.reason) ctx.alert("ok", `${p.coin} delta-neutral pair closed (${p.reason})`);
          ctx.onDone?.({ coin: p.coin, ids: legs, openedAt: p.openedAt ?? null }); // both legs closed: a complete exit
          changed = true;
          continue;
        }
        if (gone.length === 1 && p.state === "open") {
          const left = legs.find((id) => open.has(id));
          if (ctx.autoClose(p.coin)) {
            startClosing(mainId, [left], `the other leg (${gone[0]}) closed`);
            ctx.alert("warn", `${p.coin} position ${gone[0]} closed; closing its pair ${left} (auto close)`);
          } else {
            p.state = "done";
            p.doneAt = Date.now();
            ctx.alert("warn", `${p.coin} position ${gone[0]} closed; its pair ${left} is left open (auto close is off)`);
          }
          changed = true;
        }
        if (p.state !== "closing") continue;
        for (const [id, c] of Object.entries(p.closing)) {
          if (!open.has(id) || ctx.closeQueued(id)) continue; // gone, or papertrade has the close queued
          const now = Date.now();
          if (c.sentAt && now - c.sentAt < CLOSE_RESEND_MS) continue;
          if (c.sentAt && now - c.since > CLOSE_ALERT_MS && !c.alerted) {
            c.alerted = true;
            ctx.alert("error", `${p.coin} position ${id} should have closed with its pair but is still open; close it on papertrade`);
          }
          try {
            await ctx.exec("ptClose", { positionId: id, coin: p.coin });
            c.sentAt = now;
          } catch (err) {
            c.sentAt = now - CLOSE_RESEND_MS + 1500;
            c.lastError = String(err.message || err);
          }
          changed = true;
        }
      }
      for (const [id, p] of Object.entries(pairs)) {
        if (p.state === "done" && Date.now() - (p.doneAt ?? 0) > DONE_KEEP_MS) {
          delete pairs[id];
          changed = true;
        }
      }
      if (changed) {
        await save();
        ctx.emit();
      }
      ensureRunning();
    } finally {
      stepping = false;
    }
  }

  // ---------- commands ----------
  // "Close both", or a stop loss / take profit on one leg with auto close on: close every open leg now
  async function closePair(positionId, reason = "closed both legs") {
    const found = partnerOf(String(positionId));
    if (!found) return false;
    startClosing(found.mainId, [found.mainId, found.pair.hedgeId], reason);
    await save();
    ensureRunning();
    ctx.emit();
    tick();
    return true;
  }

  // a stop loss / take profit fired on `positionId`: with auto close, its pair goes too
  function onExitHit(positionId, reason) {
    const found = partnerOf(String(positionId));
    if (!found || !ctx.autoClose(found.pair.coin)) return;
    startClosing(found.mainId, [found.other], reason);
    save();
    ensureRunning();
    tick();
  }

  function snapshot() {
    return {
      pairs: Object.entries(pairs)
        .filter(([, p]) => p.state !== "done")
        .map(([mainId, p]) => ({ mainId, hedgeId: p.hedgeId, coin: p.coin, mainIsLong: p.mainIsLong, state: p.state })),
      pending: pending.map((p) => ({ coin: p.coin, mainIsLong: p.mainIsLong, mainId: p.mainId, hedgeId: p.hedgeId, at: p.at })),
    };
  }

  async function init() {
    await load();
    ensureRunning();
  }

  return { init, arm, closePair, onExitHit, partnerOf: (id) => partnerOf(String(id))?.other ?? null, snapshot, managing: () => pending.length > 0 || Object.values(pairs).some((p) => p.state !== "done") };
}
