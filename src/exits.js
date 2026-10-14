// Stop loss and take profit for papertrade positions. Papertrade has neither, so each position's
// levels are kept here, watched on Hyperliquid's mid (papertrade fills at that price) and closed
// through papertrade's own Close button. Any number of positions, on either coin.
//
// Levels set in the order form are "pending" until papertrade fills the order (it queues opens),
// then attached to the new position; % and $ targets are resolved from the actual fill price.
//
// A target is { kind: "price" | "roe" | "usd", value }: an absolute price, a return on margin in %,
// or a P&L in dollars. Gains and losses are both entered as positive numbers.

const TICK_MS = 500;
const CLOSE_RESEND_MS = 6_000;
const CLOSE_ALERT_MS = 45_000;
const PENDING_TTL_MS = 10 * 60_000; // a queued open older than this isn't the order the levels were for
const MATCH_SLACK_MS = 5_000; // papertrade's openedAtMs is block time, a little before or after the click

export function levelFromTarget(target, side, pos) {
  if (!target || !(target.value > 0)) return null;
  const dir = pos.isLong ? 1 : -1;
  const sign = side === "tp" ? 1 : -1; // tp: price moves in the position's favour; sl: against it
  if (target.kind === "price") return target.value;
  const usd = target.kind === "roe" ? (target.value / 100) * pos.margin : target.value;
  return pos.entry + (sign * dir * usd) / pos.size;
}

// which level a price range touched (a single price: low = high)
export function levelHit(x, low, high) {
  const slHit = x.slPx != null && (x.isLong ? low <= x.slPx : high >= x.slPx);
  const tpHit = x.tpPx != null && (x.isLong ? high >= x.tpPx : low <= x.tpPx);
  return slHit ? "stop loss" : tpHit ? "take profit" : null;
}

// a level on the wrong side of entry would fire at once
export function checkLevels({ isLong, entry, tpPx, slPx }) {
  if (tpPx != null && (isLong ? tpPx <= entry : tpPx >= entry)) return `Take profit must be ${isLong ? "above" : "below"} the entry price`;
  if (slPx != null && (isLong ? slPx >= entry : slPx <= entry)) return `Stop loss must be ${isLong ? "below" : "above"} the entry price`;
  return null;
}

// ctx: { positions(mids): [{ id, coin, isLong, entry, size, margin, bust, openedAtMs }] (every coin it can
//        decode; papertrade's raw prices are read against each coin's mid),
//        readableCoins(mids): coins whose positions(mids) is complete,
//        closeQueued(id), ptLive(), subscribeMid(coin, fn) → stop, exec, alert, emit }
export function createExits(ctx) {
  let exits = {}; // positionId → { coin, isLong, entry, tpPx, slPx, state, reason, closeSentAt, attempts, stateAt }
  let pending = null; // { coin, isLong, tp, sl, at, knownIds }
  let mids = {}; // coin → { px, at }
  const subs = new Map(); // coin → stop()
  let timer = null;
  let stepping = false;

  async function load() {
    const saved = await chrome.storage.local.get(["exits", "pendingExit"]);
    exits = saved.exits ?? {};
    pending = saved.pendingExit ?? null;
  }
  const save = () => chrome.storage.local.set({ exits, pendingExit: pending });

  const midPx = () => Object.fromEntries(Object.entries(mids).map(([c, m]) => [c, m.px]));
  const armed = () => Object.entries(exits).filter(([, x]) => x.state === "armed" || x.state === "closing");

  function ensureRunning() {
    const coins = new Set(armed().map(([, x]) => x.coin));
    if (pending) coins.add(pending.coin);
    for (const coin of coins) {
      if (subs.has(coin)) continue;
      subs.set(coin, () => {});
      ctx.subscribeMid(coin, (px) => {
        mids[coin] = { px, at: Date.now() };
        check(coin);
      }).then(
        (stop) => subs.set(coin, stop),
        () => subs.delete(coin),
      );
    }
    for (const [coin, stop] of subs) {
      if (coins.has(coin)) continue;
      stop();
      subs.delete(coin);
    }
    if (!timer && (coins.size || armed().length)) timer = setInterval(tick, TICK_MS);
    if (timer && !coins.size && !armed().length) {
      clearInterval(timer);
      timer = null;
    }
  }

  function check(coin) {
    const m = mids[coin];
    if (!m) return;
    for (const [id, x] of armed()) {
      if (x.coin !== coin || x.state !== "armed") continue;
      const hit = levelHit(x, m.px, m.px);
      if (!hit) continue;
      Object.assign(x, { state: "closing", reason: hit, stateAt: Date.now(), hitPx: m.px });
      ctx.alert("warn", `${hit === "stop loss" ? "Stop loss" : "Take profit"} hit on ${x.coin} position ${id} at ${m.px.toLocaleString("en-US")}: closing it`);
      save();
      ctx.emit();
      tick();
    }
  }

  async function tick() {
    if (stepping) return;
    stepping = true;
    try {
      if (!ctx.ptLive()) return; // decisions need papertrade's current positions
      const positions = ctx.positions(midPx());
      const open = new Map(positions.map((p) => [p.id, p]));
      // a coin whose positions can't be read yet (no price for it since a restart) says nothing
      // about whether its positions closed
      const readable = new Set(ctx.readableCoins(midPx()));
      attachPending(positions);
      let changed = false;
      for (const [id, x] of Object.entries(exits)) {
        if (x.state === "done" || !readable.has(x.coin)) continue;
        if (!open.has(id)) {
          // closed by its level, by hand, or liquidated: nothing left to watch
          x.state = "done";
          x.stateAt = Date.now();
          if (x.reason) ctx.alert("ok", `${x.coin} position ${id} closed (${x.reason})`);
          changed = true;
          continue;
        }
        if (x.state !== "closing") continue;
        if (ctx.closeQueued(id)) continue; // never resend while papertrade has it queued
        const now = Date.now();
        if (x.closeSentAt && now - x.closeSentAt < CLOSE_RESEND_MS) continue;
        if (x.closeSentAt && now - x.stateAt > CLOSE_ALERT_MS && !x.alerted) {
          x.alerted = true;
          ctx.alert("error", `${x.coin} position ${id} hit its ${x.reason} but is still open — close it on papertrade`);
        }
        try {
          await ctx.exec("ptClose", { positionId: id, coin: x.coin });
          x.attempts = (x.attempts ?? 0) + 1;
          x.closeSentAt = now;
        } catch (err) {
          x.closeSentAt = now - CLOSE_RESEND_MS + 1500;
          x.lastError = String(err.message || err);
        }
        changed = true;
      }
      // forget finished exits after a while so storage doesn't grow
      for (const [id, x] of Object.entries(exits)) {
        if (x.state === "done" && Date.now() - x.stateAt > 60_000) {
          delete exits[id];
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

  function attachPending(positions) {
    if (!pending) return;
    if (Date.now() - pending.at > PENDING_TTL_MS) {
      ctx.alert("warn", "The TP/SL set with your last order expired: that order never filled on papertrade");
      pending = null;
      save();
      return;
    }
    const fresh = positions.find(
      (p) => p.coin === pending.coin && p.isLong === pending.isLong && !pending.knownIds.includes(p.id) && p.openedAtMs >= pending.at - MATCH_SLACK_MS,
    );
    if (!fresh) return;
    const tpPx = levelFromTarget(pending.tp, "tp", fresh);
    const slPx = levelFromTarget(pending.sl, "sl", fresh);
    const bad = checkLevels({ isLong: fresh.isLong, entry: fresh.entry, tpPx, slPx });
    if (bad) {
      ctx.alert("error", `TP/SL not set on ${fresh.coin} position ${fresh.id}: ${bad} (it filled at ${fresh.entry})`);
    } else {
      exits[fresh.id] = { coin: fresh.coin, isLong: fresh.isLong, entry: fresh.entry, tpPx, slPx, state: "armed", stateAt: Date.now() };
      ctx.alert("ok", `TP/SL set on ${fresh.coin} position ${fresh.id}`);
    }
    pending = null;
    save();
    ctx.emit();
  }

  // ---------- commands ----------
  async function set({ positionId, tpPx = null, slPx = null }) {
    const p = ctx.positions(midPx()).find((x) => x.id === String(positionId));
    if (!p) throw new Error("That position isn't open on papertrade");
    if (tpPx == null && slPx == null) {
      delete exits[p.id];
    } else {
      const bad = checkLevels({ isLong: p.isLong, entry: p.entry, tpPx, slPx });
      if (bad) throw new Error(bad);
      // a level the price is already past would close at once: refuse rather than surprise
      const m = mids[p.coin]?.px;
      if (m && levelHit({ isLong: p.isLong, tpPx, slPx }, m, m)) throw new Error(`The price (${m.toLocaleString("en-US")}) is already past that level`);
      exits[p.id] = { coin: p.coin, isLong: p.isLong, entry: p.entry, tpPx, slPx, state: "armed", stateAt: Date.now() };
    }
    await save();
    ensureRunning();
    ctx.emit();
  }

  async function arm({ coin, isLong, tp, sl }) {
    if (!(tp?.value > 0) && !(sl?.value > 0)) {
      pending = null;
    } else {
      const knownIds = ctx.positions(midPx()).filter((p) => p.coin === coin).map((p) => p.id);
      pending = { coin, isLong, tp: tp?.value > 0 ? tp : null, sl: sl?.value > 0 ? sl : null, at: Date.now(), knownIds };
    }
    await save();
    ensureRunning();
    ctx.emit();
  }

  function snapshot() {
    return {
      byPosition: Object.fromEntries(Object.entries(exits).filter(([, x]) => x.state !== "done").map(([id, x]) => [id, { ...x }])),
      pending: pending ? { ...pending } : null,
    };
  }

  async function init() {
    await load();
    ensureRunning();
  }

  return { init, set, arm, snapshot, managing: () => armed().length > 0 || !!pending };
}
