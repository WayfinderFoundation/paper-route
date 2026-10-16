// Multi-coin Tether: BTC and ETH lanes hedge independently against a fake papertrade stream and a
// fake Hyperliquid account. No network. Run: node test/lanes.mjs
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
      set: async (o) => Object.assign(store, o),
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
    },
  },
};
const { createHedgeEngine } = await import("../src/hedge.js");
const { privateKeyToAccount } = await import("viem/accounts");
const AGENT_KEY = `0x${"11".repeat(32)}`;

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

const WALLET = "0x00000000000000000000000000000000000000aa";
const MIDS = { BTC: 80_000, ETH: 2_500 };
const hlSize = { BTC: 0, ETH: 0 };
const orders = [];
const fakeHl = {
  loadMeta: async () => ({ BTC: { szDecimals: 5, maxLeverage: 40 }, ETH: { szDecimals: 4, maxLeverage: 25 } }),
  abstraction: async () => "unifiedAccount",
  accounts: async (_user, coins) => ({
    shared: { accountValue: 0, marginUsed: 0, withdrawable: 0, spotUsdc: 5_000, spotUsdcTotal: 5_000, positions: [], spot: [] },
    byCoin: Object.fromEntries(coins.map((c) => [c, { mid: MIDS[c], size: hlSize[c], entry: MIDS[c], uPnl: 0, funding: 0, liqPx: null, leverage: { value: 10, isCross: true }, availableToTrade: [50_000, 50_000] }])),
  }),
  subscribeMid: async () => () => {},
  fills: async () => [{ coin: "ETH", closedPnl: "-1.5", fee: "2.0", builderFee: "0.5" }],
  funding: async () => [{ delta: { coin: "ETH", usdc: "-0.1" } }],
  setLeverage: async () => {},
  builderFeeApproved: async () => true,
  openOrders: async () => [],
  cancel: async () => {},
  placeTrigger: async () => 1,
  marketOrder: async (_s, { coin, isBuy, size }) => {
    orders.push({ coin, isBuy, size });
    hlSize[coin] = +(hlSize[coin] + (isBuy ? size : -size)).toFixed(6);
    return { coin, size, avgPx: MIDS[coin] };
  },
};

let pt = null;
const net = { BTC: 0, ETH: 0 };
const frame = () => ({ net: { ...net }, funds: { availableBalance: "0" }, balance: "0", operations: [] });
const engine = createHedgeEngine({
  publish: () => {},
  exec: async () => ({}),
  io: {
    createHl: () => fakeHl,
    subscribeAccount: (_w, handlers) => {
      pt = handlers;
      return () => {};
    },
    tradingLimitsAll: async () => ({ BTC: {}, ETH: {} }),
    winFeeRate: async () => 0.02,
    summarize: (f, coin) => ({ netSize: f.net[coin], bust: null, available: 0, queued: 0, uPnlAfterFee: 0 }),
    positionsOf: (f, coin) => (f.net[coin] ? [{ id: `${coin}-${f.net[coin]}`, coin, margin: (Math.abs(f.net[coin]) * MIDS[coin]) / 100, leverage: 100, openedAtMs: Date.now() - 5_000 }] : []),
    closedTrades: async (_w, ids) => Object.fromEntries(ids.map((id) => [id, { paidUsd: 0.5, paper: 100, liquidated: false }])),
    getAgent: async () => ({ privateKey: AGENT_KEY, address: privateKeyToAccount(AGENT_KEY).address }),
    getSecret: async () => null,
    vaultStatus: async () => ({ unlocked: false }),
  },
});

store.ptSessionWallet = "0x00000000000000000000000000000000000000cc";
store.ptPageCoin = "BTC";
store.tether = { hedgeWallet: WALLET, coins: { BTC: true, ETH: true } };

console.log("# both coins tethered after a restart");
await engine.configure({ hedgeWallet: WALLET });
pt.onStatus("live");
pt.onFrame(frame());
check(await until(() => engine.snapshot().lanes.BTC.auto && engine.snapshot().lanes.ETH.auto, 2000), "Tether resumes on BTC and ETH");

console.log("\n# fills on both coins hedge both, whichever page is open");
net.BTC = 0.1;
net.ETH = -2;
pt.onFrame(frame());
check(await until(() => hlSize.BTC === -0.1 && hlSize.ETH === 2, 4000), `HL short 0.1 BTC and long 2 ETH (got BTC ${hlSize.BTC}, ETH ${hlSize.ETH})`);
check(orders.length === 2, `one order per coin (${orders.length})`);

console.log("\n# the page only changes which coin the panel shows");
await engine.setPageCoin({ coin: "ETH" });
const s = engine.snapshot();
check(s.settings.coin === "ETH" && s.hl.account.size === 2 && s.pt.summary.netSize === -2, "snapshot top level is the ETH lane");
check(s.lanes.BTC.hedge === -0.1 && s.lanes.BTC.open, "BTC still reported in lanes");
check(s.managing, "managing while tethered positions are open");

console.log("\n# Tether off on one coin leaves the other running");
await engine.setAuto({ on: false, coin: "BTC" });
check(store.tether.coins.BTC === false && store.tether.coins.ETH === true, "saved per coin");
net.BTC = 0.2;
net.ETH = -3;
pt.onFrame(frame());
check(await until(() => hlSize.ETH === 3, 5000), "ETH follows its new fill");
await sleep(600);
check(hlSize.BTC === -0.1, "BTC left alone with its Tether off");

console.log("\n# a big hedge goes out in chunks, not refused");
{
  const before = orders.length;
  net.ETH = -60; // $150K at 2,500: three $50K chunks
  pt.onFrame(frame());
  check(await until(() => hlSize.ETH === 60, 8000), `ETH hedged to +60 (got ${hlSize.ETH})`);
  const chunks = orders.slice(before).filter((o) => o.coin === "ETH");
  check(chunks.length === 3 && chunks.every((o) => o.size * MIDS.ETH <= 50_000 + 1), `3 orders of at most $50K (${chunks.map((o) => o.size).join(", ")})`);
}

console.log("\n# delta neutral: coverage and venue");
{
  await engine.setDeltaNeutral({ coin: "ETH", on: true, venue: "hl", coverage: 0.5 });
  net.ETH = -10; // papertrade short 10 ETH → hedge long 5 at 50 %
  pt.onFrame(frame());
  check(await until(() => hlSize.ETH === 5, 6000), `50 % coverage hedges half (ETH hedge ${hlSize.ETH})`);
  check(engine.snapshot().dn.coverage === 0.5 || engine.snapshot().settings.coin !== "ETH", "coverage in the snapshot");
  await engine.setDeltaNeutral({ coin: "ETH", venue: "pt" });
  check(engine.snapshot().lanes.ETH.auto === false && store.hedgeSettings.dn.ETH.venue === "pt", "papertrade venue turns Tether off for that coin");
  await engine.setDeltaNeutral({ coin: "ETH", venue: "hl", coverage: 1 });
  check(engine.snapshot().lanes.ETH.auto === true, "back to Hyperliquid turns it on again");
  await engine.setAuto({ on: false, coin: "ETH" });
  check(store.hedgeSettings.dn.ETH.on === false, "the HUD's Tether switch keeps delta neutral in step");
  await engine.setAuto({ on: true, coin: "ETH" });
}

console.log("\n# a finished delta-neutral trade on Hyperliquid gets a cost-per-Paper summary");
{
  net.ETH = 0; // papertrade closes; Tether unwinds the hedge
  pt.onFrame(frame());
  check(await until(() => hlSize.ETH === 0, 8000), "hedge unwound");
  check(await until(() => engine.snapshot().dnSummary?.coin === "ETH", 10000), "summary published once the hedge is flat");
  const c = engine.snapshot().dnSummary;
  check(c && c.venue === "hl" && c.paper > 0 && Number.isFinite(c.costPerPaper), `ETH: ${c?.paper} Paper, net $${c?.net?.toFixed(2)}, $${c?.costPerPaper?.toFixed(4)} per Paper`);
}

console.log("\n# per-coin leverage");
await engine.setLeverage({ leverage: 5, cross: false, coin: "BTC" });
check(store.hedgeSettings.leverage.BTC.value === 5 && engine.snapshot().settings.hlLeverage === 10, "BTC at 5x; the ETH view keeps the default");

console.log("\n# papertrade page self-check");
const alertsBefore = engine.snapshot().alerts.length;
engine.setPageCheck({ ok: false, problems: ["Close button for position 7: 2 matches"] });
let sn = engine.snapshot();
check(sn.pageCheck.ok === false && /page changed \(Close button for position 7: 2 matches\)/.test(sn.alerts[0].text), "a failed check alerts with the problem");
engine.setPageCheck({ ok: false, problems: ["Close button for position 7: 2 matches"] });
check(engine.snapshot().alerts.filter((a) => /page changed/.test(a.text)).length === 1, "the same failure doesn't alert again");
engine.setPageCheck({ ok: true, problems: [] });
sn = engine.snapshot();
check(sn.pageCheck.ok && /passes again/.test(sn.alerts[0].text), "recovery is announced");
check(sn.alerts.length >= alertsBefore + 2, "two alerts in total");

console.log("\n# a Hyperliquid action that never returns can't block the engine");
{
  let hangOnce = true;
  const sizes = { BTC: 0, ETH: 0 };
  const hl2 = {
    ...fakeHl,
    accounts: async (_u, coins) => {
      const r = await fakeHl.accounts(_u, coins);
      for (const c of coins) r.byCoin[c].size = sizes[c];
      return r;
    },
    marketOrder: async (_s, { coin, isBuy, size }) => {
      if (hangOnce) {
        hangOnce = false;
        return new Promise(() => {}); // never settles
      }
      sizes[coin] = +(sizes[coin] + (isBuy ? size : -size)).toFixed(6);
      return { coin, size, avgPx: MIDS[coin] };
    },
  };
  let pt2 = null;
  const e2 = createHedgeEngine({
    publish: () => {},
    exec: async () => ({}),
    io: {
      createHl: () => hl2,
      subscribeAccount: (_w, h) => {
        pt2 = h;
        return () => {};
      },
      tradingLimitsAll: async () => ({ BTC: {}, ETH: {} }),
      winFeeRate: async () => 0.02,
      summarize: (f, coin) => ({ netSize: f.net[coin], bust: null, available: 0, queued: 0, uPnlAfterFee: 0 }),
      positionsOf: (f, coin) => (f.net[coin] ? [{ margin: (Math.abs(f.net[coin]) * MIDS[coin]) / 100, leverage: 100 }] : []),
      getAgent: async () => ({ privateKey: AGENT_KEY, address: privateKeyToAccount(AGENT_KEY).address }),
      getSecret: async () => null,
      vaultStatus: async () => ({ unlocked: false }),
      jobTimeoutMs: 600,
    },
  });
  store.tether = { hedgeWallet: WALLET, coins: { BTC: false, ETH: true } };
  await e2.configure({ hedgeWallet: WALLET });
  pt2.onStatus("live");
  pt2.onFrame({ net: { BTC: 0, ETH: 1 }, funds: { availableBalance: "0" }, balance: "0", operations: [] });
  check(await until(() => e2.snapshot().alerts.some((a) => /timed out after/.test(a.text)), 4000), "the stuck order times out with an alert");
  check(await until(() => sizes.ETH === -1, 6000), `the hedge is retried and placed (ETH hedge ${sizes.ETH})`);
  check(e2.snapshot().busy === null && e2.snapshot().lanes.ETH.auto, "engine idle again, Tether still on");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
