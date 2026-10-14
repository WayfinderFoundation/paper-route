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
    byCoin: Object.fromEntries(coins.map((c) => [c, { mid: MIDS[c], size: hlSize[c], entry: MIDS[c], uPnl: 0, funding: 0, liqPx: null, leverage: { value: 10, isCross: true }, availableToTrade: [5_000, 5_000] }])),
  }),
  subscribeMid: async () => () => {},
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
    positionsOf: () => [],
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

console.log("\n# per-coin leverage");
await engine.setLeverage({ leverage: 5, cross: false, coin: "BTC" });
check(store.hedgeSettings.leverage.BTC.value === 5 && engine.snapshot().settings.hlLeverage === 10, "BTC at 5x; the ETH view keeps the default");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
