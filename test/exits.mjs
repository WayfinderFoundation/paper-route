// Stop loss / take profit engine against a simulated papertrade + Hyperliquid mid. No network.
// Run: node test/exits.mjs
import { checkLevels, createExits, levelFromTarget, levelHit } from "../src/exits.js";

const store = {};
globalThis.chrome = { storage: { local: { get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])), set: async (o) => Object.assign(store, o) } } };

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(20);
  }
  return false;
};

// ---------- maths ----------
{
  // short 0.1 BTC from 80,000 with $50 margin (160x)
  const pos = { isLong: false, entry: 80_000, size: 0.1, margin: 50 };
  check(near(levelFromTarget({ kind: "roe", value: 50 }, "tp", pos), 80_000 - 25 / 0.1), "TP at +50% ROE on a short = entry − ($25 / size)");
  check(near(levelFromTarget({ kind: "usd", value: 10 }, "sl", pos), 80_000 + 10 / 0.1), "SL at −$10 on a short = entry + ($10 / size)");
  check(levelFromTarget({ kind: "price", value: 79_000 }, "tp", pos) === 79_000, "a price target is used as is");
  check(levelFromTarget({ kind: "roe", value: 0 }, "tp", pos) === null, "no value → no level");
  const long = { isLong: true, entry: 80_000, size: 0.1, margin: 50 };
  check(near(levelFromTarget({ kind: "roe", value: 50 }, "tp", long), 80_250), "TP on a long is above entry");
  check(checkLevels({ isLong: true, entry: 80_000, tpPx: 79_000, slPx: null }) !== null, "a long's TP below entry is refused");
  check(checkLevels({ isLong: false, entry: 80_000, tpPx: 79_000, slPx: 80_500 }) === null, "a short's TP below and SL above entry are fine");
  check(levelHit({ isLong: false, tpPx: 79_000, slPx: 80_500 }, 80_600, 80_600) === "stop loss", "short: price above SL → stop loss");
  check(levelHit({ isLong: false, tpPx: 79_000, slPx: 80_500 }, 78_900, 78_900) === "take profit", "short: price below TP → take profit");
  check(levelHit({ isLong: false, tpPx: 79_000, slPx: 80_500 }, 79_500, 79_500) === null, "between the levels → nothing");
}

// ---------- engine ----------
function world() {
  const w = { positions: [], queued: new Set(), live: true, closes: [], alerts: [], midFns: {} };
  const ctx = {
    positions: () => (w.blind ? [] : w.positions),
    readableCoins: () => (w.blind ? [] : ["BTC", "ETH"]),
    closeQueued: (id) => w.queued.has(id),
    ptLive: () => w.live,
    mid: async (coin) => w.polled?.[coin] ?? null,
    subscribeMid: async (coin, fn) => {
      w.midFns[coin] = fn;
      return () => delete w.midFns[coin];
    },
    exec: async (action, args) => {
      if (action === "ptClose") w.closes.push(args.positionId);
      return { clicked: true };
    },
    alert: (level, text) => w.alerts.push({ level, text }),
    emit: () => {},
  };
  w.mid = (coin, px) => w.midFns[coin]?.(px);
  return { w, ctx };
}
const pos = (id, extra = {}) => ({ id, coin: "BTC", isLong: false, entry: 80_000, size: 0.1, margin: 50, bust: 80_400, openedAtMs: Date.now(), leverage: 160, ...extra });

{
  console.log("\n# set levels, price crosses, papertrade queues the close");
  const { w, ctx } = world();
  store.exits = {};
  store.pendingExit = null;
  w.positions = [pos("1"), pos("2", { coin: "ETH", entry: 2_500, size: 4 })];
  const x = createExits(ctx);
  await x.init();
  w.mid("BTC", 80_000); // nothing subscribed yet
  await x.set({ positionId: "1", tpPx: 79_000, slPx: 80_300 });
  await until(() => w.midFns.BTC, 500);
  check(!!w.midFns.BTC, "watching BTC once a BTC position has levels");
  check(!w.midFns.ETH, "not watching ETH (no levels there)");
  w.mid("BTC", 79_500);
  await sleep(600);
  check(w.closes.length === 0, "no close between the levels");
  w.mid("BTC", 80_310);
  await until(() => w.closes.length === 1, 1500);
  check(w.closes[0] === "1", "stop loss crossed → papertrade Close clicked for that position");
  w.queued.add("1");
  await sleep(1200);
  check(w.closes.length === 1, "close queued on papertrade → never resent");
  w.queued.delete("1");
  w.positions = w.positions.filter((p) => p.id !== "1");
  await until(() => !x.snapshot().byPosition["1"], 1500);
  check(!x.snapshot().byPosition["1"], "position gone → its TP/SL is done");
  check(w.alerts.some((a) => /closed \(stop loss\)/.test(a.text)), "says why it closed");
}

{
  console.log("\n# levels set in the order form attach to the position when it fills");
  const { w, ctx } = world();
  store.exits = {};
  store.pendingExit = null;
  w.positions = [pos("10")];
  const x = createExits(ctx);
  await x.init();
  await x.arm({ coin: "BTC", isLong: true, tp: { kind: "roe", value: 100 }, sl: { kind: "usd", value: 5 } });
  check(!!x.snapshot().pending, "pending until papertrade fills the order");
  await sleep(700);
  check(Object.keys(x.snapshot().byPosition).length === 0, "the position that was already open doesn't get them");
  w.positions.push(pos("11", { isLong: true, entry: 81_000, size: 0.2, margin: 40 }));
  await until(() => x.snapshot().byPosition["11"], 1500);
  const e = x.snapshot().byPosition["11"];
  check(!!e && near(e.tpPx, 81_000 + 40 / 0.2) && near(e.slPx, 81_000 - 5 / 0.2), `resolved from the fill price: TP ${e?.tpPx} SL ${e?.slPx}`);
  check(!x.snapshot().pending, "pending cleared once attached");
  check(x.managing(), "managing while levels are armed");
}

{
  console.log("\n# a restart before prices load doesn't drop levels");
  const { w, ctx } = world();
  store.exits = { 30: { coin: "BTC", isLong: false, entry: 80_000, tpPx: 79_000, slPx: null, state: "closing", reason: "take profit", stateAt: Date.now() } };
  w.positions = [pos("30")];
  w.blind = true; // no BTC price yet: positions can't be decoded
  const x = createExits(ctx);
  await x.init();
  await sleep(1200);
  check(!!x.snapshot().byPosition["30"] && w.closes.length === 0, "kept while the position can't be read");
  w.blind = false;
  await until(() => w.closes.length === 1, 1500);
  check(w.closes[0] === "30", "once readable, the pending close goes out");
}

{
  console.log("\n# a level the price is already past is refused");
  const { w, ctx } = world();
  store.exits = {};
  w.positions = [pos("20")];
  const x = createExits(ctx);
  await x.init();
  await x.set({ positionId: "20", tpPx: 79_000, slPx: null });
  await until(() => w.midFns.BTC, 500);
  w.mid("BTC", 79_800);
  let refused = null;
  await x.set({ positionId: "20", tpPx: 79_900, slPx: null }).catch((e) => (refused = e.message));
  check(/already past/.test(refused ?? ""), `refused: ${refused}`);
}

{
  console.log("\n# the price socket goes quiet: levels are checked against a fetched price");
  const { w, ctx } = world();
  store.exits = {};
  store.pendingExit = null;
  w.positions = [pos("40")];
  const x = createExits(ctx);
  await x.init();
  await x.set({ positionId: "40", tpPx: 79_000, slPx: null });
  await until(() => w.midFns.BTC, 500);
  w.mid("BTC", 79_500); // one push, then silence
  await sleep(600);
  check(w.closes.length === 0, "nothing hit yet");
  w.polled = { BTC: 78_900 };
  check(await until(() => w.closes[0] === "40", 6000), "take profit hit on the fetched price, socket still silent");
}

{
  console.log("\n# no price at all for a while: reported as unwatched");
  const { w, ctx } = world();
  store.exits = {};
  w.positions = [pos("50")];
  const x = createExits(ctx);
  await x.init();
  await x.set({ positionId: "50", tpPx: 79_000, slPx: null });
  check(x.snapshot().unwatched.length === 0, "not flagged straight away");
  check(await until(() => x.snapshot().unwatched.includes("BTC"), 10_000), "flagged once no price has arrived for 8 s");
  w.mid("BTC", 79_500);
  check(x.snapshot().unwatched.length === 0, "cleared by the next price");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
