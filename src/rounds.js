// Rounds: at a chosen time (or now), open papertrade with a stop and a limit and hold an opposite
// Hyperliquid leg for exactly as long as the papertrade position exists. Each round is a persisted state machine that is
// re-derived from live data every tick, so it heals after API errors, a dropped stream, a
// closed tab or a service-worker restart:
//
//   scheduled → opening → hedging → live → closing → flattening → done
//                  ↘ failed (missed window / never opened)          ↗ (papertrade bust or manual close)
//
// Papertrade has no native stop or take-profit, so the levels are watched here (HL websocket mids,
// which papertrade tracks to <1 bp) and closed through papertrade's own Close button, in a papertrade
// tab the worker opens if none is. Nothing watches while Chrome is closed or the extension is off;
// on resume, 1-minute candles since the last watch tell whether a level was crossed meanwhile.
// (`limitPct` / `limitPx` is the take-profit; either level may be null = not set.)
// Papertrade queues both opens and closes (sometimes for minutes), so by default the HL hedge
// follows papertrade FILLS: it opens when the position appears in papertrade's account and
// closes when it leaves. Opt-in `hlBrackets` instead rests HL TP/SL at the levels
// (HL take-profit = papertrade stop price, HL stop-loss = papertrade limit price).

export const LEVEL_PRESETS = [0.1, 0.2, 0.35, 1];
const MAX_LEVEL_PCT = 50;

const TICK_MS = 500;
const LATE_WINDOW_MS = 30_000; // don't open a round more than 30 s after its time
const OPEN_RESEND_MS = 8_000;
const OPEN_MAX_ATTEMPTS = 3;
const CLOSE_RESEND_MS = 6_000;
const CLOSE_ALERT_MS = 45_000;
const HEDGE_RETRY_MS = 3_000;
const HISTORY = 20;
const WATCH_SAVE_MS = 5_000; // how often the "still watching" timestamp is persisted
const MISSED_GAP_MS = 3_000; // a watch gap longer than this gets checked against candles

const isActive = (r) => !["done", "failed", "cancelled"].includes(r.state);
const validLevel = (v) => v === null || (Number.isFinite(v) && v > 0 && v <= MAX_LEVEL_PCT);
const pctText = (v) => (v === null ? "none" : `${v}%`);

export function createRounds(ctx) {
  let rounds = [];
  let timer = null;
  let stepping = false;
  let lastMid = null;
  let stopMids = null;
  let lastWatchSave = 0;

  // ---------- persistence ----------
  async function load() {
    const { rounds: saved } = await chrome.storage.local.get("rounds");
    rounds = saved ?? [];
  }
  const save = () => chrome.storage.local.set({ rounds: rounds.slice(-HISTORY) });

  function log(r, text, level = null) {
    r.log = [...(r.log ?? []), { at: Date.now(), text }].slice(-12);
    if (level) ctx.alert(level, `Round ${r.label}: ${text}`);
  }

  function transition(r, state, text, level = null) {
    r.state = state;
    r.stateAt = Date.now();
    if (!isActive(r)) r.endedAt = r.stateAt;
    log(r, text, level);
  }

  function failOpen(r, text) {
    return transition(r, "failed", text, "error");
  }

  // ---------- papertrade helpers ----------
  const ptPositions = () => (ctx.ptFrame()?.openPositions ?? []).filter((t) => t[1] === ctx.instrumentId());
  const pendingOps = (action) => (ctx.ptFrame()?.operations ?? []).filter((op) => op[1] === action);

  // ---------- commands ----------
  async function schedule(spec) {
    const now = Date.now();
    if (!(spec.at > now - 1000)) throw new Error("Pick a time in the future");
    spec = { ...spec, stopPct: spec.stopPct ?? null, limitPct: spec.limitPct ?? null };
    if (!validLevel(spec.stopPct) || !validLevel(spec.limitPct)) throw new Error(`Stop and take profit must be between 0 and ${MAX_LEVEL_PCT}% (or off)`);
    if (spec.hlBrackets && (spec.stopPct === null || spec.limitPct === null)) throw new Error("Hyperliquid brackets need both a stop and a take profit");
    if (!(spec.marginUsd > 0) || !(spec.ptLeverage >= 1)) throw new Error("Margin and leverage are required");
    if (rounds.some((r) => isActive(r) && r.state !== "scheduled")) throw new Error("A round is already running");
    const r = {
      id: crypto.randomUUID(),
      label: new Date(spec.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      createdAt: now,
      ...spec,
      state: "scheduled",
      stateAt: now,
      attempts: { open: 0, close: 0 },
      log: [],
    };
    log(r, `Scheduled: ${spec.side} $${spec.marginUsd} × ${spec.ptLeverage}x, stop ${pctText(spec.stopPct)} / take profit ${pctText(spec.limitPct)}${spec.hedge ? ", hedged on HL" : ""}`);
    rounds.push(r);
    await save();
    ensureRunning();
    if (spec.immediate) {
      tick();
    } else {
      // wake the service worker for the open even if nothing else keeps it alive
      chrome.alarms.create(`round:${r.id}`, { when: Math.max(now + 1000, spec.at - 2000) });
    }
    ctx.emit();
    return r.id;
  }

  // a round is managing positions: opening, holding or closing either leg (scheduled ones count too:
  // they need the browser running at their time)
  const managing = () => rounds.some(isActive);
  const activeRound = () => rounds.find((r) => isActive(r) && r.state !== "scheduled") ?? null;
  // any unfinished round (scheduled included) pins the engine to its coin; old rounds predate multi-coin
  const lockedCoin = () => {
    const r = rounds.find(isActive);
    return r ? (r.coin ?? "BTC") : null;
  };

  async function cancel(id) {
    const r = rounds.find((x) => x.id === id);
    if (!r) throw new Error("Unknown round");
    if (r.state === "scheduled") {
      transition(r, "cancelled", "Cancelled before opening");
    } else if (r.state === "opening") {
      transition(r, "cancelled", "Cancelled while opening — check papertrade for a queued open", "warn");
    } else if (["hedging", "live"].includes(r.state)) {
      r.reason = "manual";
      transition(r, "closing", "Closing now (manual)");
    } else {
      throw new Error(`Round is already ${r.state}`);
    }
    await save();
    ctx.emit();
  }

  // ---------- engine ----------
  function ensureRunning() {
    if (!timer && rounds.some(isActive)) timer = setInterval(tick, TICK_MS);
    if (!stopMids && rounds.some(isActive)) startMids();
  }

  async function startMids() {
    stopMids = () => {}; // placeholder so it isn't started twice
    try {
      stopMids = await ctx.hl().subscribeMid(ctx.coin(), (m) => {
        lastMid = { px: m, at: Date.now() };
        const live = rounds.find((r) => r.state === "live");
        if (live) checkLevels(live);
      });
    } catch (err) {
      stopMids = null;
      ctx.alert("warn", `HL price websocket unavailable (${err.message}); using 1 s polling`);
    }
  }

  function currentMid() {
    if (lastMid && Date.now() - lastMid.at < 3000) return lastMid.px;
    return ctx.hlAccount()?.mid ?? null;
  }

  // which level a price range touched (a single price: low = high = price)
  function levelHit(r, low, high) {
    const stopHit = r.stopPx != null && (r.isLong ? low <= r.stopPx : high >= r.stopPx);
    const tpHit = r.limitPx != null && (r.isLong ? high >= r.limitPx : low <= r.limitPx);
    return stopHit ? "stop" : tpHit ? "take profit" : null;
  }

  function checkLevels(r) {
    const m = currentMid();
    if (!m || r.state !== "live") return;
    const hit = levelHit(r, m, m);
    if (!hit) return;
    r.reason = hit;
    transition(r, "closing", `${hit === "stop" ? "Stop" : "Take profit"} hit at ${m.toFixed(1)}`);
    save();
    ctx.emit();
    tick();
  }

  // the browser or extension was off while the round was live: did a level trade meanwhile?
  async function checkMissed(r, now) {
    const since = Math.max(r.missedFrom, Math.ceil(r.openedAt / 60_000) * 60_000);
    if (now - since < 60_000) {
      r.missedFrom = null; // shorter than one candle: the live price is all there is
      return;
    }
    let range;
    try {
      range = await ctx.hl().priceRange(r.coin ?? ctx.coin(), since, now);
    } catch (err) {
      r.missedTries = (r.missedTries ?? 0) + 1;
      if (r.missedTries < 3) throw err; // the step logs it; retried next tick
      log(r, `Couldn't check what happened while Paper Route wasn't running (${err.message}); watching from now`, "warn");
      range = null;
    }
    r.missedFrom = null;
    if (!range) return;
    const hit = levelHit(r, range.low, range.high);
    if (!hit) return log(r, `Checked the ${Math.round((now - since) / 60_000)} min Paper Route wasn't watching: no level crossed`);
    r.reason = `${hit} (crossed while Paper Route wasn't running)`;
    transition(r, "closing", `${hit === "stop" ? "Stop" : "Take profit"} was crossed while Paper Route wasn't running — closing now`, "warn");
  }

  async function tick() {
    if (stepping) return;
    stepping = true;
    try {
      const now = Date.now();
      for (const r of rounds.filter((x) => x.state === "live" && !x.missedFrom)) r.watchedAt = now;
      if (now - lastWatchSave > WATCH_SAVE_MS && rounds.some((x) => x.state === "live")) {
        lastWatchSave = now;
        await save();
      }
      for (const r of rounds.filter(isActive)) {
        const before = r.state;
        try {
          await step(r);
        } catch (err) {
          log(r, `Step error in ${r.state}: ${err.message}`);
          r.lastError = { at: Date.now(), text: err.message };
        }
        if (r.state !== before) await save();
      }
      // auto-hedge must not re-hedge into a closing move
      ctx.setHold(rounds.some((r) => r.state === "closing"));
      if (!rounds.some(isActive)) {
        clearInterval(timer);
        timer = null;
        await stopMids?.();
        stopMids = null;
      }
      ctx.emit();
    } finally {
      stepping = false;
    }
  }

  async function step(r) {
    const now = Date.now();
    // every decision past "scheduled" reads papertrade's account; acting on a stale frame
    // (stream reconnecting) could re-send an open that already landed, so wait instead
    if (r.state !== "scheduled" && !ctx.ptLive()) {
      if (r.state === "opening" && r.attempts.open === 0 && now > r.at + LATE_WINDOW_MS) {
        return failOpen(r, "Papertrade account stream was down through the open window");
      }
      if (!r.waitingPt) log(r, "Waiting for papertrade account stream");
      r.waitingPt = true;
      return;
    }
    r.waitingPt = false;
    switch (r.state) {
      case "scheduled": {
        if (now < r.at) return;
        if (now > r.at + LATE_WINDOW_MS) return transition(r, "failed", "Missed the open window (extension wasn't running)", "error");
        r.isLong = resolveSide(r);
        // balances move between scheduling and firing: re-check against both venues now
        const c = ctx.capacity(r.isLong, r.ptLeverage, r.hedge);
        if (!c.ok) return transition(r, "failed", `Can't open: ${c.problems[0]}`, "error");
        if (r.marginUsd > c.maxMargin) {
          log(r, `Margin cut from $${r.marginUsd} to $${c.maxMargin} — limited by ${c.binding}`, "warn");
          r.marginUsd = c.maxMargin;
        }
        if (r.marginUsd < c.minMargin) return transition(r, "failed", `Can't open: margin $${r.marginUsd} is under the $${c.minMargin} minimum`, "error");
        r.knownIds = ptPositions().map((t) => String(t[0]));
        transition(r, "opening", `Opening papertrade ${r.isLong ? "long" : "short"} $${r.marginUsd} × ${r.ptLeverage}x`);
        return step(r);
      }

      case "opening": {
        // the hedge follows papertrade FILLS: a queued open is not a position yet (papertrade can
        // hold intents in its queue for minutes), so nothing happens on HL until it shows up here
        const fresh = ptPositions().find((t) => !r.knownIds.includes(String(t[0])) && t[2] === r.isLong);
        if (fresh) {
          r.ptQueue = null;
          return onOpened(r, fresh);
        }
        if (pendingOps("openPosition").length) {
          if (!r.ptQueue) log(r, "Papertrade open queued — HL waits for the fill");
          r.ptQueue ??= { kind: "open", since: now };
          r.sawQueued = true;
          return; // never resend while queued
        }
        if (r.sawQueued) {
          // it was queued and is gone without a position: papertrade dropped/expired it; the
          // moment has passed, so don't send another
          r.ptQueue = null;
          return failOpen(r, "Papertrade dropped the queued open (expired or rejected)");
        }
        const waited = now - (r.openSentAt ?? 0);
        if (r.attempts.open >= OPEN_MAX_ATTEMPTS) {
          // out of tries: give the last one time to land, then give up — never send a 4th
          if (waited > OPEN_RESEND_MS + 4000) return failOpen(r, `Papertrade didn't open after ${r.attempts.open} tries`);
          return;
        }
        if (r.openSentAt && waited < OPEN_RESEND_MS) return;
        if (now > r.at + LATE_WINDOW_MS && r.attempts.open === 0) return failOpen(r, "No papertrade tab to open in before the window closed");
        try {
          const res = await ctx.exec("ptOpen", { coin: r.coin ?? ctx.coin(), isLong: r.isLong, marginUsd: r.marginUsd, leverage: r.ptLeverage });
          r.attempts.open += 1;
          r.openSentAt = now;
          log(r, `Papertrade open sent (try ${r.attempts.open})${res?.autoOpened ? " from a papertrade tab Paper Route opened" : ""}`, res?.autoOpened ? "warn" : null);
        } catch (err) {
          if (/didn't answer/.test(err.message)) {
            // the tab may have clicked and only the reply was lost: count it as sent and wait the
            // full resend window, by which time papertrade shows the position or a queued intent
            r.attempts.open += 1;
            r.openSentAt = now;
            log(r, `No reply from papertrade tab; treating open as possibly sent (try ${r.attempts.open})`);
          } else {
            log(r, `Papertrade open failed: ${err.message}`);
            r.openSentAt = now - OPEN_RESEND_MS + 2000; // refused before clicking: retry in ~2 s
          }
        }
        return;
      }

      case "hedging": {
        if (!ptPositions().some((t) => String(t[0]) === r.positionId)) return transition(r, "flattening", "Papertrade position closed before the hedge finished");
        if (now - (r.hedgeTriedAt ?? 0) < HEDGE_RETRY_MS) return;
        r.hedgeTriedAt = now;
        await ctx.hedgeNow("round");
        const acct = await ctx.refreshHl();
        if (Math.abs(ctx.delta()?.deltaUsd ?? Infinity) > ctx.bandUsd()) return log(r, "Hedge still off target; retrying");
        // default: HL exits only when papertrade's exit fills (flattening), so it can't close
        // ahead of a queued papertrade close. Resting HL TP/SL are opt-in (spec.hlBrackets).
        if (!r.hlBrackets) return transition(r, "live", "Hedged — HL follows papertrade's fills");
        await placeBrackets(r, acct);
        return transition(r, "live", `Hedged; HL TP ${r.stopPx.toFixed(1)} / SL ${r.limitPx.toFixed(1)}`);
      }

      case "live": {
        if (!ptPositions().some((t) => String(t[0]) === r.positionId)) {
          r.reason ??= "papertrade closed (bust or manual)";
          return transition(r, "flattening", "Papertrade position closed");
        }
        if (r.missedFrom) {
          await checkMissed(r, now);
          if (r.state !== "live") return;
        }
        checkLevels(r);
        if (r.state !== "live" || !r.hedge) return;
        // heal the HL leg: re-hedge if it drifted, re-place brackets if they went missing
        if (now - (r.healAt ?? 0) < HEDGE_RETRY_MS) return;
        r.healAt = now;
        let acct = await ctx.refreshHl();
        if (r.hlBrackets && acct.size === 0) {
          // HL's resting bracket fired before the papertrade watcher saw the level: close
          // papertrade too rather than re-hedging into the move
          r.reason = "HL bracket fired";
          return transition(r, "closing", "HL TP/SL filled; closing papertrade");
        }
        if (Math.abs(ctx.delta()?.deltaUsd ?? 0) > ctx.bandUsd()) {
          // papertrade is still open, so HL must match it
          log(r, "HL hedge drifted; re-hedging");
          await ctx.hedgeNow("round");
          acct = await ctx.refreshHl();
        }
        if (!r.hlBrackets) return;
        const open = await ctx.hl().openOrders(ctx.hedgeWallet(), ctx.coin());
        const oids = new Set(open.map((o) => o.oid));
        const sized = open.filter((o) => o.oid === r.hl?.tpOid || o.oid === r.hl?.slOid).every((o) => Math.abs(Number(o.sz) - Math.abs(acct.size)) < 1e-9);
        if (!oids.has(r.hl?.tpOid) || !oids.has(r.hl?.slOid) || !sized) {
          log(r, "HL TP/SL missing or mis-sized; re-placing");
          await ctx.hl().cancel(await ctx.signer(), ctx.coin(), [r.hl?.tpOid, r.hl?.slOid].filter((o) => oids.has(o)));
          await placeBrackets(r, acct);
        }
        return;
      }

      case "closing": {
        // HL is untouched until papertrade's close FILLS (the position leaves its account);
        // a queued close keeps papertrade exposed, so the hedge stays on
        const stillOpen = ptPositions().some((t) => String(t[0]) === r.positionId);
        if (!stillOpen) {
          r.ptQueue = null;
          return transition(r, "flattening", `Papertrade closed (${r.reason})`);
        }
        if (pendingOps("closePositions").some((op) => (op[9] ?? []).map(String).includes(r.positionId))) {
          if (!r.ptQueue) log(r, "Papertrade close queued — HL stays hedged until it fills");
          r.ptQueue ??= { kind: "close", since: now };
          return; // never resend while queued
        }
        r.ptQueue = null;
        if (r.closeSentAt && now - r.closeSentAt < CLOSE_RESEND_MS) return;
        if (r.closeSentAt && now - r.stateAt > CLOSE_ALERT_MS && !r.closeAlerted) {
          r.closeAlerted = true;
          log(r, "Papertrade still open — close it manually if this persists", "error");
        }
        try {
          const res = await ctx.exec("ptClose", { positionId: r.positionId, coin: r.coin ?? ctx.coin() });
          r.attempts.close += 1;
          r.closeSentAt = now;
          log(r, `Papertrade close sent (try ${r.attempts.close})${res?.autoOpened ? " from a papertrade tab Paper Route opened" : ""}`, res?.autoOpened ? "warn" : null);
        } catch (err) {
          log(r, `Papertrade close failed: ${err.message}`);
          r.closeSentAt = now - CLOSE_RESEND_MS + 1500;
        }
        return;
      }

      case "flattening": {
        if (!r.hedge) return transition(r, "done", "Done");
        if (now - (r.flatTriedAt ?? 0) < HEDGE_RETRY_MS) return;
        r.flatTriedAt = now;
        const s = await ctx.signer();
        await ctx.hl().cancel(s, ctx.coin(), [r.hl?.tpOid, r.hl?.slOid].filter((o) => o !== undefined));
        // hedge target is -(remaining papertrade size), which is 0 unless other positions are open
        await ctx.hedgeNow("round");
        await ctx.refreshHl();
        if (Math.abs(ctx.delta()?.deltaUsd ?? Infinity) > ctx.bandUsd()) return log(r, "HL not flat yet; retrying");
        return transition(r, "done", `Done (${r.reason})`, "ok");
      }
    }
  }

  function resolveSide(r) {
    if (r.side === "long") return true;
    if (r.side === "short") return false;
    throw new Error(`Unknown side ${r.side}`);
  }

  function onOpened(r, t) {
    r.positionId = String(t[0]);
    r.openedAt = Date.now();
    const entry = ctx.decodePrice(t[4]);
    r.entry = entry;
    const away = (pct, dir) => (pct === null ? null : entry * (1 + (dir * pct) / 100));
    r.stopPx = away(r.stopPct, r.isLong ? -1 : 1);
    r.limitPx = away(r.limitPct, r.isLong ? 1 : -1);
    const bust = ctx.decodePrice(t[7]);
    r.bustPx = bust;
    if (r.stopPx != null && (r.isLong ? r.stopPx <= bust : r.stopPx >= bust)) log(r, `Stop ${r.stopPct}% is past papertrade's bust (${bust.toFixed(1)}); it will bust first`, "warn");
    const lv = (px) => (px == null ? "none" : px.toFixed(1));
    transition(r, r.hedge ? "hedging" : "live", `Papertrade open @ ${entry.toFixed(1)} · stop ${lv(r.stopPx)} · take profit ${lv(r.limitPx)}`);
  }

  async function placeBrackets(r, acct) {
    if (acct.size === 0) throw new Error("No HL position to bracket");
    r.hl = await ctx.hl().placeBrackets(await ctx.signer(), {
      coin: ctx.coin(),
      closeIsBuy: acct.size < 0,
      size: Math.abs(acct.size),
      tpPx: r.stopPx, // papertrade's stop is the HL leg's profit
      slPx: r.limitPx, // papertrade's limit is the HL leg's loss
    });
  }

  function snapshot() {
    return rounds.slice(-6).map((r) => ({
      id: r.id, label: r.label, at: r.at, state: r.state, side: r.side, isLong: r.isLong,
      marginUsd: r.marginUsd, ptLeverage: r.ptLeverage, stopPct: r.stopPct, limitPct: r.limitPct, hedge: r.hedge,
      entry: r.entry, stopPx: r.stopPx ?? null, limitPx: r.limitPx ?? null, bustPx: r.bustPx ?? null, reason: r.reason,
      coin: r.coin ?? "BTC", stateAt: r.stateAt, endedAt: r.endedAt ?? null,
      openedAt: r.openedAt ?? null, ptQueue: r.ptQueue ?? null, hlBrackets: !!r.hlBrackets,
      lastLog: r.log?.[r.log.length - 1]?.text ?? null, lastError: r.lastError ?? null,
    }));
  }

  async function init() {
    await load();
    // resume anything that was mid-flight when the worker stopped
    if (rounds.some(isActive)) {
      for (const r of rounds.filter(isActive)) {
        log(r, "Resumed after restart");
        // levels weren't watched since watchedAt: check the candles before trusting the live price
        if (r.state === "live" && r.watchedAt && Date.now() - r.watchedAt > MISSED_GAP_MS) r.missedFrom = r.watchedAt;
      }
      ensureRunning();
    }
  }

    // stops watching (a worker shutting down); persisted rounds resume in the next init()
  async function stop() {
    clearInterval(timer);
    timer = null;
    await stopMids?.();
    stopMids = null;
  }

  return { init, schedule, cancel, snapshot, activeRound, lockedCoin, managing, stop, wake: () => { ensureRunning(); tick(); } };
}
