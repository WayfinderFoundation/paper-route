// Dry run of the round scheduler against simulated papertrade + Hyperliquid with injected
// failures. No network, no keys, no orders. Run: node test/rounds.mjs
import { webcrypto } from "node:crypto";
import { createRounds } from "../src/rounds.js";

globalThis.crypto ??= webcrypto; // Chrome has it; Node 18 doesn't

// ---------- chrome stubs ----------
const store = {};
globalThis.chrome = {
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } },
  alarms: { create: () => {} },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};
const until = async (pred, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(50);
  }
  console.log(`     (timed out waiting for ${label})`);
  return false;
};

// ---------- simulated world ----------
function world() {
  const w = {
    mid: 82_000,
    ptLive: true,
    frame: { openPositions: [], operations: [] },
    hl: { size: 0, orders: [] },
    nextPos: 100,
    calls: { ptOpen: 0, ptClose: 0, hedge: 0, brackets: 0, cancel: 0 },
    faults: { ptOpenTransient: 0, ptOpenQueued: false, hedgeFail: 0, bracketFail: 0, ptCloseIgnore: 0 },
    midListener: null,
    alerts: [],
  };
  const scale = 10n * 10n ** 18n; // price raw = px * 10 * 1e18 (decoded via ctx.decodePrice)
  const openPosition = (isLong, margin, lev) => {
    const entry = BigInt(Math.round(w.mid * 10)) * 10n ** 18n;
    const bust = BigInt(Math.round(w.mid * (isLong ? 1 - 1 / lev : 1 + 1 / lev) * 10)) * 10n ** 18n;
    w.frame.openPositions.push([String(w.nextPos++), 0, isLong, false, entry.toString(), String(BigInt(Math.round(margin * 100)) * 10n ** 16n), lev, bust.toString(), Date.now(), null]);
  };
  const ptNet = () => w.frame.openPositions.reduce((s, t) => s + (t[2] ? 1 : -1) * ((Number(BigInt(t[5])) / 1e18) * t[6]) / (Number(BigInt(t[4])) / Number(scale)), 0);

  const hlApi = {
    subscribeMid: async (_coin, fn) => {
      w.midListener = fn;
      return async () => {};
    },
    openOrders: async () => w.hl.orders.map((o) => ({ oid: o.oid, sz: String(Math.abs(w.hl.size)) })),
    priceRange: async (_coin, start, end) => {
      w.calls.priceRange = { start, end };
      return w.range ?? null;
    },
    placeBrackets: async (_s, b) => {
      w.calls.brackets++;
      if (w.faults.bracketFail-- > 0) throw new Error("Hyperliquid order failed: fetch failed");
      const tp = { oid: Math.floor(Math.random() * 1e9), kind: "tp", px: b.tpPx, closeIsBuy: b.closeIsBuy };
      const sl = { oid: Math.floor(Math.random() * 1e9), kind: "sl", px: b.slPx, closeIsBuy: b.closeIsBuy };
      w.hl.orders = [tp, sl];
      w.lastBrackets = b;
      return { tpOid: tp.oid, slOid: sl.oid };
    },
    cancel: async (_s, _c, oids) => {
      w.calls.cancel++;
      w.hl.orders = w.hl.orders.filter((o) => !oids.includes(o.oid));
    },
  };

  const ctx = {
    hl: () => hlApi,
    signer: async () => ({ address: "0xhedge" }),
    coin: () => "BTC",
    instrumentId: () => 0,
    hedgeWallet: () => "0xhedge",
    bandUsd: () => 50,
    ptFrame: () => w.frame,
    ptLive: () => w.ptLive,
    hlAccount: () => ({ mid: w.mid, size: w.hl.size }),
    delta: () => {
      const d = -ptNet() - w.hl.size;
      return { delta: d, deltaUsd: d * w.mid, mid: w.mid };
    },
    decodePrice: (raw) => Number(BigInt(raw)) / Number(scale),
    refreshHl: async () => ({ mid: w.mid, size: w.hl.size }),
    hedgeNow: async () => {
      w.calls.hedge++;
      if (w.faults.hedgeFail-- > 0) throw new Error("Hyperliquid account failed: 502");
      w.hl.size = -ptNet();
    },
    setHold: (on) => (w.hold = on),
    capacity: () => w.capacity ?? { ok: true, maxMargin: 1e9, minMargin: 0, problems: [], binding: null },
    exec: async (action, args) => {
      if (action === "ptOpen") {
        w.calls.ptOpen++;
        if (w.faults.ptOpenTransient-- > 0) throw new Error("Place Trade is disabled on papertrade (balance, minimum size or trading paused)");
        if (w.faults.ptOpenQueued) {
          // papertrade accepts the intent but only indexes it later; meanwhile it is "queued"
          w.frame.operations = [["intent-1", "openPosition", 0, args.isLong, false, "0", args.leverage, Date.now(), "1", null]];
          setTimeout(() => {
            w.frame.operations = [];
            openPosition(args.isLong, args.marginUsd, args.leverage);
          }, 2500);
          return { clicked: true };
        }
        setTimeout(() => openPosition(args.isLong, args.marginUsd, args.leverage), 300);
        return { clicked: true };
      }
      if (action === "ptClose") {
        w.calls.ptClose++;
        if (w.faults.ptCloseIgnore-- > 0) return { clicked: true }; // click lost
        setTimeout(() => {
          w.frame.openPositions = w.frame.openPositions.filter((t) => String(t[0]) !== String(args.positionId));
        }, 300);
        return { clicked: true };
      }
    },
    alert: (level, text) => w.alerts.push({ level, text }),
    emit: () => {},
  };
  return { w, ctx };
}

const rid = (rounds) => store.rounds.at(-1);

// ---------- 1: happy path with transient failures everywhere ----------
{
  console.log("\n# scenario 1: stop hit, with a lost open, a failed hedge, failed brackets, a lost close click");
  const { w, ctx } = world();
  w.faults = { ptOpenTransient: 1, ptOpenQueued: false, hedgeFail: 1, bracketFail: 1, ptCloseIgnore: 1 };
  const rounds = createRounds(ctx);
  await rounds.init();
  await rounds.schedule({ at: Date.now() + 300, side: "long", marginUsd: 100, ptLeverage: 100, stopPct: 0.2, limitPct: 0.35, hedge: true, hlBrackets: true });
  await until(() => rid().state === "live", 25_000, "live");
  const r = rid();
  check(r.state === "live", `reached live (${r.state})`);
  check(w.frame.openPositions.length === 1, `exactly one papertrade position opened (${w.frame.openPositions.length}) after ${w.calls.ptOpen} open attempts`);
  check(Math.abs(w.hl.size + 100 * 100 / 82_000) < 1e-9, `HL hedged opposite at the same size (${w.hl.size.toFixed(5)})`);
  check(Math.abs(r.stopPx - 82_000 * 0.998) < 0.01 && Math.abs(r.limitPx - 82_000 * 1.0035) < 0.01, `levels from entry: stop ${r.stopPx.toFixed(1)} limit ${r.limitPx.toFixed(1)}`);
  check(w.lastBrackets.tpPx === r.stopPx && w.lastBrackets.slPx === r.limitPx && w.lastBrackets.closeIsBuy === true, "HL TP = paper stop, SL = paper limit, buy-to-close the short");
  w.mid = 82_000 * 0.9979;
  w.midListener(w.mid);
  await until(() => rid().state === "done", 20_000, "done");
  check(rid().state === "done" && rid().reason === "stop", `closed on stop → done (${rid().state}, ${rid().reason})`);
  check(w.frame.openPositions.length === 0 && w.hl.size === 0, "papertrade closed and HL flat");
  check(w.calls.ptClose >= 2, `lost close click was retried (${w.calls.ptClose} close clicks)`);
  check(w.hl.orders.length === 0, "HL TP/SL cancelled");
  check(w.hold === false, "hedge hold released");
}

// ---------- 2: papertrade queues the open — must never resend while queued ----------
{
  console.log("\n# scenario 2: open sits in papertrade's queue for 2.5s");
  const { w, ctx } = world();
  w.faults.ptOpenQueued = true;
  const rounds = createRounds(ctx);
  store.rounds = [];
  await rounds.init();
  await rounds.schedule({ at: Date.now() + 200, side: "short", marginUsd: 50, ptLeverage: 200, stopPct: 0.1, limitPct: 0.1, hedge: false });
  await until(() => rid().state === "live", 10_000, "live");
  check(w.calls.ptOpen === 1, `one open click despite the queue (${w.calls.ptOpen})`);
  check(w.frame.openPositions.length === 1 && w.frame.openPositions[0][2] === false, "short opened");
  await rounds.cancel(rid().id);
  await until(() => rid().state === "done", 10_000, "done");
  check(rid().state === "done", "manual close → done (no hedge leg)");
}

// ---------- 3: HL bracket fires first; stream outage; restart mid-round ----------
{
  console.log("\n# scenario 3: stream outage, worker restart, then HL bracket fires before the watcher");
  const { w, ctx } = world();
  store.rounds = [];
  let rounds = createRounds(ctx);
  await rounds.init();
  await rounds.schedule({ at: Date.now() + 200, side: "long", marginUsd: 100, ptLeverage: 100, stopPct: 0.35, limitPct: 1, hedge: true, hlBrackets: true });
  await until(() => rid().state === "live", 10_000, "live");

  w.ptLive = false;
  const opensBefore = w.calls.ptOpen;
  await sleep(1200);
  check(rid().log.some((l) => /Waiting for papertrade/.test(l.text)), "waits while papertrade stream is down");
  w.ptLive = true;

  // simulate a worker restart: brand-new scheduler instance resuming from storage
  rounds = createRounds(ctx);
  await rounds.init();
  await sleep(800);
  check(rid().state === "live" && rid().log.some((l) => /Resumed after restart/.test(l.text)), "resumed live round after restart");

  // brackets vanish (e.g. cancelled elsewhere) → healed
  w.hl.orders = [];
  await until(() => w.hl.orders.length === 2, 8000, "brackets re-placed");
  check(w.hl.orders.length === 2, "missing HL TP/SL re-placed");

  // HL's SL fills (price ripped up) before our watcher: HL flat, papertrade still open
  w.hl.size = 0;
  w.hl.orders = [];
  await until(() => rid().state === "done", 15_000, "done");
  check(rid().reason === "HL bracket fired", `papertrade closed because HL bracket fired (${rid().reason})`);
  check(w.calls.ptOpen === opensBefore, "never re-opened papertrade");
  check(w.hl.size === 0, "HL stayed flat (not re-hedged into the move)");
}

// ---------- 3b: tab clicks but its reply is lost — must not double-open ----------
{
  console.log("\n# scenario 3b: papertrade tab clicks Place Trade but the reply times out");
  const { w, ctx } = world();
  store.rounds = [];
  const realExec = ctx.exec;
  let first = true;
  ctx.exec = async (action, args) => {
    if (action === "ptOpen" && first) {
      first = false;
      w.calls.ptOpen++;
      setTimeout(() => {
        // the position shows up 4 s later, after the "no reply" — slower than a quick retry
        const entry = BigInt(Math.round(w.mid * 10)) * 10n ** 18n;
        w.frame.openPositions.push(["900", 0, args.isLong, false, entry.toString(), String(100n * 10n ** 18n), 100, entry.toString(), Date.now(), null]);
      }, 4000);
      throw new Error("papertrade tab didn't answer ptOpen in 10s");
    }
    return realExec(action, args);
  };
  const rounds = createRounds(ctx);
  await rounds.init();
  await rounds.schedule({ at: Date.now() + 200, side: "long", marginUsd: 100, ptLeverage: 100, stopPct: 0.2, limitPct: 0.2, hedge: false });
  await until(() => rid().state === "live", 12_000, "live");
  check(w.calls.ptOpen === 1 && w.frame.openPositions.length === 1, `lost reply did not cause a second open (${w.calls.ptOpen} clicks, ${w.frame.openPositions.length} positions)`);
  await rounds.cancel(rid().id);
  await until(() => rid().state === "done", 10_000, "done");
}

// ---------- 3c: balances shrank between scheduling and firing ----------
{
  console.log("\n# scenario 3c: capacity re-checked at fire time");
  const { w, ctx } = world();
  store.rounds = [];
  w.capacity = { ok: true, maxMargin: 60, minMargin: 50, problems: [], binding: "Hyperliquid margin" };
  const rounds = createRounds(ctx);
  await rounds.init();
  await rounds.schedule({ at: Date.now() + 200, side: "long", marginUsd: 100, ptLeverage: 200, stopPct: 0.2, limitPct: 0.2, hedge: false });
  await until(() => rid().state === "live", 8000, "live");
  const pos = w.frame.openPositions[0];
  check(rid().marginUsd === 60 && pos && Number(BigInt(pos[5]) / 10n ** 18n) === 60, `margin cut to the max that fits both venues ($${rid().marginUsd})`);
  await rounds.cancel(rid().id);
  await until(() => rid().state === "done", 10_000, "done");

  w.capacity = { ok: false, maxMargin: 40, minMargin: 50, problems: ["Needs ≥ $50 margin ($10,000 min notional) but max is $40 (limited by Hyperliquid margin)"], binding: "Hyperliquid margin" };
  const opens = w.calls.ptOpen;
  await rounds.schedule({ at: Date.now() + 200, side: "long", marginUsd: 100, ptLeverage: 200, stopPct: 0.2, limitPct: 0.2, hedge: false });
  await until(() => rid().state === "failed", 5000, "failed");
  check(rid().state === "failed" && w.calls.ptOpen === opens, "round that no longer fits fails without opening");
}

// ---------- 5: "Open now" round — HL follows papertrade FILLS through its queue ----------
{
  console.log("\n# scenario 5: papertrade queues the open and the close; HL only moves on fills");
  const { w, ctx } = world();
  store.rounds = [];
  const realExec = ctx.exec;
  ctx.exec = async (action, args) => {
    if (action === "ptOpen") {
      w.calls.ptOpen++;
      w.frame.operations = [["i-open", "openPosition", 0, args.isLong, false, "0", args.leverage, Date.now(), "1", null]];
      setTimeout(() => {
        w.frame.operations = [];
        // fills 3 s later, after the price moved
        w.mid = 82_100;
        const entry = BigInt(Math.round(w.mid * 10)) * 10n ** 18n;
        w.frame.openPositions.push(["700", 0, args.isLong, false, entry.toString(), String(BigInt(Math.round(args.marginUsd * 100)) * 10n ** 16n), args.leverage, entry.toString(), Date.now(), null]);
      }, 3000);
      return { clicked: true };
    }
    if (action === "ptClose") {
      w.calls.ptClose++;
      w.frame.operations = [["i-close", "closePositions", 0, null, null, null, null, Date.now(), "1", [String(args.positionId)]]];
      setTimeout(() => {
        w.frame.operations = [];
        w.frame.openPositions = w.frame.openPositions.filter((t) => String(t[0]) !== String(args.positionId));
      }, 3000);
      return { clicked: true };
    }
    return realExec(action, args);
  };
  const rounds = createRounds(ctx);
  await rounds.init();
  const t0 = Date.now();
  await rounds.schedule({ at: t0, side: "short", marginUsd: 24.75, ptLeverage: 404, stopPct: 0.2, limitPct: 0.2, hedge: true, immediate: true, coin: "BTC" });
  await until(() => w.calls.ptOpen === 1, 1000, "papertrade click");
  check(Date.now() - t0 < 600, `papertrade clicked right away (${Date.now() - t0} ms)`);
  await sleep(2000);
  check(w.hl.size === 0 && rid().ptQueue?.kind === "open", "while papertrade's open is queued, HL stays flat");
  check(w.calls.ptOpen === 1, "queued open is never resent");
  await until(() => rid().state === "live", 10_000, "live");
  const r = rid();
  check(Math.abs(w.hl.size - (24.75 * 404) / 82_100) < 1e-9, "HL opened only after the fill, at papertrade's size");
  check(Math.abs(r.entry - 82_100) < 0.01 && Math.abs(r.stopPx - 82_100 * 1.002) < 0.01, `levels from papertrade's fill price (${r.entry})`);
  check(w.calls.brackets === 0, "no resting HL TP/SL that could fire ahead of papertrade");

  // stop hit → papertrade close queued for 3 s → HL must stay hedged until it fills
  w.mid = 82_100 * 1.0021;
  w.midListener(w.mid);
  await until(() => rid().ptQueue?.kind === "close", 3000, "close queued");
  const hlDuringClose = w.hl.size;
  await sleep(1500);
  check(rid().state === "closing" && w.hl.size === hlDuringClose && w.hl.size > 0, "while papertrade's close is queued, HL stays hedged");
  check(w.calls.ptClose === 1, "queued close is never resent");
  await until(() => rid().state === "done", 10_000, "done");
  check(rid().state === "done" && w.hl.size === 0 && w.frame.openPositions.length === 0, "HL closed only after papertrade's close filled");
  check(rid().endedAt >= rid().stateAt - 1, "exit time recorded");
}

// ---------- 5b: queued open dropped by papertrade → never resent, round fails cleanly ----------
{
  console.log("\n# scenario 5b: papertrade drops a queued open");
  const { w, ctx } = world();
  store.rounds = [];
  ctx.exec = async (action, args) => {
    if (action === "ptOpen") {
      w.calls.ptOpen++;
      w.frame.operations = [["i-open", "openPosition", 0, args.isLong, false, "0", args.leverage, Date.now(), "1", null]];
      setTimeout(() => (w.frame.operations = []), 1500); // expires without a position
      return { clicked: true };
    }
  };
  const rounds = createRounds(ctx);
  await rounds.init();
  await rounds.schedule({ at: Date.now(), side: "long", marginUsd: 40, ptLeverage: 252, stopPct: 0.35, limitPct: 0.35, hedge: true, immediate: true });
  await until(() => rid().state === "failed", 6000, "failed");
  check(rid().state === "failed" && w.calls.ptOpen === 1 && w.hl.size === 0, `dropped queued open → failed, no resend, HL untouched (${rid().log.at(-1).text})`);
}

// ---------- 6: papertrade never opens → gives up after 3 tries, HL never touched ----------
{
  console.log("\n# scenario 6: papertrade refuses every open");
  const { w, ctx } = world();
  store.rounds = [];
  const realExec = ctx.exec;
  ctx.exec = async (action, args) => {
    if (action === "ptOpen") {
      w.calls.ptOpen++;
      return { clicked: true }; // clicked, but papertrade never creates the position
    }
    return realExec(action, args);
  };
  const rounds = createRounds(ctx);
  await rounds.init();
  await rounds.schedule({ at: Date.now(), side: "long", marginUsd: 39.75, ptLeverage: 252, stopPct: 0.35, limitPct: 0.35, hedge: true, immediate: true });
  await until(() => rid().state === "failed", 45_000, "failed");
  check(rid().state === "failed", `round failed and says so (${rid().log.at(-1).text})`);
  check(w.hl.size === 0 && w.calls.hedge === 0, "HL never traded — the hedge only follows fills");
  check(w.calls.ptOpen === 3, `papertrade tried the configured 3 times (${w.calls.ptOpen})`);
}

// ---------- 7: a round pins its coin until it's finished ----------
{
  console.log("\n# scenario 7: round coin lock");
  const { ctx } = world();
  store.rounds = [];
  const rounds = createRounds(ctx);
  await rounds.init();
  check(rounds.lockedCoin() === null, "no rounds → nothing locked");
  await rounds.schedule({ at: Date.now() + 60_000, side: "long", marginUsd: 10, ptLeverage: 10, stopPct: 0.2, limitPct: 0.2, hedge: true, coin: "ETH" });
  check(rounds.lockedCoin() === "ETH", "a scheduled ETH round pins the engine to ETH");
  await rounds.cancel(rid().id);
  check(rounds.lockedCoin() === null, "cancelled → unlocked");
  store.rounds = [{ id: "old", label: "old", at: Date.now() + 60_000, state: "scheduled", side: "long", marginUsd: 1, ptLeverage: 1, stopPct: 0.1, limitPct: 0.1, hedge: false, attempts: { open: 0, close: 0 }, log: [] }];
  const r2 = createRounds(ctx);
  await r2.init();
  check(r2.lockedCoin() === "BTC", "a persisted round without a coin (pre multi-coin) is BTC");
  await r2.cancel("old");
}

// ---------- 8: take profit only, and no exits at all ----------
{
  console.log("\n# scenario 8: take profit without a stop; a round with no exits");
  const { w, ctx } = world();
  store.rounds = [];
  const rounds = createRounds(ctx);
  await rounds.init();
  await rounds.schedule({ at: Date.now(), side: "long", marginUsd: 100, ptLeverage: 100, stopPct: null, limitPct: 0.2, hedge: true, immediate: true });
  await until(() => rid().state === "live", 10_000, "live");
  check(rid().stopPx === null && Math.abs(rid().limitPx - 82_000 * 1.002) < 0.01, "no stop level, take profit 0.2% above entry");
  w.mid = 82_000 * 0.99; // far below: there is no stop, so nothing happens
  w.midListener(w.mid);
  await sleep(1200);
  check(rid().state === "live", "a drop doesn't close a round without a stop");
  w.mid = 82_000 * 1.0021;
  w.midListener(w.mid);
  await until(() => rid().state === "done", 10_000, "done");
  check(rid().state === "done" && rid().reason === "take profit", `closed on take profit (${rid().reason})`);

  store.rounds = [];
  const r2 = createRounds(ctx);
  await r2.init();
  w.mid = 82_000;
  await r2.schedule({ at: Date.now(), side: "short", marginUsd: 100, ptLeverage: 100, hedge: true, immediate: true });
  await until(() => rid().state === "live", 10_000, "live");
  w.mid = 82_000 * 1.05;
  w.midListener(w.mid);
  await sleep(1200);
  check(rid().state === "live" && rid().limitPx === null, "no exits set → stays open until closed by hand");
  await r2.cancel(rid().id);
  await until(() => rid().state === "done", 10_000, "done");
  let refused = null;
  await r2.schedule({ at: Date.now(), side: "long", marginUsd: 1, ptLeverage: 1, stopPct: 0.2, limitPct: 80, hedge: false }).catch((e) => (refused = e.message));
  check(/between 0 and 50/.test(refused ?? ""), `out-of-range level refused (${refused})`);
}

// ---------- 9: a level crossed while nothing was watching ----------
{
  console.log("\n# scenario 9: Chrome was closed for 10 minutes during a live round");
  for (const [label, range, expectClose] of [
    ["take profit traded while away", { low: 81_950, high: 82_300 }, true],
    ["nothing crossed while away", { low: 81_950, high: 82_100 }, false],
  ]) {
    const { w, ctx } = world();
    w.range = range;
    store.rounds = [];
    const rounds = createRounds(ctx);
    await rounds.init();
    await rounds.schedule({ at: Date.now(), side: "long", marginUsd: 100, ptLeverage: 100, stopPct: 0.2, limitPct: 0.2, hedge: true, immediate: true });
    await until(() => rid().state === "live", 10_000, "live");
    // pretend the browser went away 10 minutes ago, 20 minutes into the round
    const r = rid();
    r.openedAt = Date.now() - 30 * 60_000;
    r.watchedAt = Date.now() - 10 * 60_000;
    await rounds.stop(); // the old worker is gone
    const restored = JSON.parse(JSON.stringify(store.rounds.map((x) => (x.id === r.id ? r : x))));
    store.rounds = restored;
    const after = createRounds(ctx);
    await after.init();
    if (expectClose) {
      await until(() => rid().state === "done", 10_000, "done");
      check(rid().state === "done" && /while Paper Route wasn't running/.test(rid().reason), `${label}: closed on resume (${rid().reason})`);
      check(w.calls.priceRange.start === restored.at(-1).watchedAt, "checked candles from the last moment it was watching");
    } else {
      await sleep(1500);
      check(rid().state === "live" && /no level crossed/.test(rid().log.map((l) => l.text).join("|")), `${label}: stays live and says it checked`);
      await after.cancel(rid().id);
      await until(() => rid().state === "done", 10_000, "done");
    }
  }
}

// ---------- 4: missed window ----------
{
  console.log("\n# scenario 4: worker wakes after the open window");
  const { ctx } = world();
  store.rounds = [{ id: "x", label: "late", at: Date.now() - 60_000, state: "scheduled", side: "long", marginUsd: 1, ptLeverage: 1, stopPct: 0.1, limitPct: 0.1, hedge: false, attempts: { open: 0, close: 0 }, log: [] }];
  const rounds = createRounds(ctx);
  await rounds.init();
  await until(() => store.rounds[0].state !== "scheduled", 3000, "failed");
  check(store.rounds[0].state === "failed", `late round fails instead of opening (${store.rounds[0].state})`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
