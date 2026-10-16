// Delta-neutral pairs on papertrade (src/pairs.js) against a simulated papertrade. No network.
// Run: node test/pairs.mjs
const store = {};
globalThis.chrome = { storage: { local: { get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])), set: async (o) => Object.assign(store, o) } } };
const { createPairs } = await import("../src/pairs.js");

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(25);
  }
  return false;
};

function world({ autoClose = true } = {}) {
  const w = { positions: [], closes: [], alerts: [], queued: new Set(), autoClose };
  const ctx = {
    positions: () => w.positions,
    readableCoins: () => ["BTC", "ETH"],
    openQueued: () => false,
    closeQueued: (id) => w.queued.has(id),
    ptLive: () => true,
    autoClose: () => w.autoClose,
    exec: async (action, { positionId }) => {
      if (action === "ptClose") w.closes.push(positionId);
      return { clicked: true };
    },
    alert: (level, text) => w.alerts.push({ level, text }),
    emit: () => {},
    onDone: (d) => (w.done ??= []).push(d),
  };
  return { w, ctx };
}
const pos = (id, isLong, extra = {}) => ({ id, coin: "BTC", isLong, openedAtMs: Date.now(), ...extra });

{
  console.log("# the two legs are paired when they fill, in either order");
  store.ptPairs = {};
  store.ptPairsPending = [];
  const { w, ctx } = world();
  w.positions = [pos("1", true, { openedAtMs: Date.now() - 60_000 })]; // already open: not part of the pair
  const p = createPairs(ctx);
  await p.init();
  p.arm({ coin: "BTC", mainIsLong: false });
  w.positions.push(pos("11", true)); // the hedge (long) fills first
  await sleep(1300);
  check(p.snapshot().pending[0]?.hedgeId === "11" && !p.snapshot().pairs.length, "hedge leg seen, waiting for the main leg");
  w.positions.push(pos("10", false));
  check(await until(() => p.snapshot().pairs.length === 1, 2500), "paired once both filled");
  const pr = p.snapshot().pairs[0];
  check(pr.mainId === "10" && pr.hedgeId === "11", `main 10 ↔ hedge 11 (got ${pr?.mainId} ↔ ${pr?.hedgeId})`);
  check(p.partnerOf("10") === "11" && p.partnerOf("11") === "10" && p.partnerOf("1") === null, "partners known both ways; the old position isn't in it");

  console.log("\n# auto close: one leg closes (e.g. liquidated) → the other is closed too");
  w.positions = w.positions.filter((x) => x.id !== "10");
  check(await until(() => w.closes.includes("11"), 2500), "the remaining leg is closed");
  w.queued.add("11");
  await sleep(1300);
  check(w.closes.filter((x) => x === "11").length === 1, "never resent while papertrade has the close queued");
  w.queued.delete("11");
  w.positions = w.positions.filter((x) => x.id !== "11");
  check(await until(() => !p.snapshot().pairs.length, 2500), "pair done once both legs are gone");
  check(w.done?.length === 1 && w.done[0].ids.join() === "10,11", "reported as a finished trade (cost summary)");
}

{
  console.log("\n# a stop loss on one leg closes both at once; Close both closes both");
  store.ptPairs = { 20: { coin: "BTC", mainIsLong: true, hedgeId: "21", state: "open", closing: {} } };
  store.ptPairsPending = [];
  const { w, ctx } = world();
  w.positions = [pos("20", true), pos("21", false)];
  const p = createPairs(ctx);
  await p.init();
  p.onExitHit("20", "stop loss"); // the exits engine closes 20 itself; the pair closes 21
  check(await until(() => w.closes.includes("21"), 2500) && !w.closes.includes("20"), "the partner is closed with the stop loss");

  store.ptPairs = { 30: { coin: "BTC", mainIsLong: true, hedgeId: "31", state: "open", closing: {} } };
  const { w: w2, ctx: c2 } = world();
  w2.positions = [pos("30", true), pos("31", false)];
  const p2 = createPairs(c2);
  await p2.init();
  check((await p2.closePair("31")) === true, "Close both from either leg");
  check(await until(() => w2.closes.includes("30") && w2.closes.includes("31"), 2500), "both legs closed");
}

{
  console.log("\n# auto close off: the other leg is left to run");
  store.ptPairs = { 40: { coin: "BTC", mainIsLong: true, hedgeId: "41", state: "open", closing: {} } };
  store.ptPairsPending = [];
  const { w, ctx } = world({ autoClose: false });
  w.positions = [pos("40", true), pos("41", false)];
  const p = createPairs(ctx);
  await p.init();
  p.onExitHit("40", "take profit");
  w.positions = [pos("41", false)];
  await sleep(1500);
  check(!w.closes.length && w.alerts.some((a) => /left open \(auto close is off\)/.test(a.text)), "nothing closed, and it says so");
  check(!w.done, "a leg left open isn't a finished trade: no cost summary");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
