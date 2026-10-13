import "./dev-reload.js";
import "./market.js";
import { createHedgeEngine, HEDGE_DEFAULTS } from "./hedge.js";
import { buildSigner } from "./signers.js";
import { forget, forgetAgent, getSecret, lock, storeSecret, unlock, vaultStatus } from "./vault.js";

const hedgePorts = new Set();
let lastPublish = 0;
let publishTimer = null;
let latest = null;

// toolbar badge: "ON" while Paper Route is responsible for positions (a round, or tether holding one)
let badgeOn = null;
function setBadge(on) {
  if (on === badgeOn) return;
  badgeOn = on;
  chrome.action.setBadgeText({ text: on ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#0DC15A" });
  chrome.action.setTitle({ title: on ? "Paper Route is managing positions — keep Chrome open and this extension enabled" : "Paper Route" });
}

// HUD gets at most ~8 snapshots/s; the newest always wins
function publish(snapshot) {
  latest = snapshot;
  setBadge(!!snapshot.managing);
  const wait = 120 - (Date.now() - lastPublish);
  if (wait > 0) {
    publishTimer ??= setTimeout(() => {
      publishTimer = null;
      publish(latest);
    }, wait);
    return;
  }
  lastPublish = Date.now();
  for (const port of hedgePorts) port.postMessage({ kind: "hedge", state: latest });
}

// Papertrade actions (open/close) can only run inside a signed-in papertrade tab; try the
// connected tabs newest-first until one accepts. Each attempt times out on its own.
const EXEC_TIMEOUT_MS = 10_000;
const pendingExec = new Map();
let execSeq = 0;

function execOn(port, action, args) {
  return new Promise((resolve, reject) => {
    const id = ++execSeq;
    const timer = setTimeout(() => {
      pendingExec.delete(id);
      reject(new Error(`papertrade tab didn't answer ${action} in ${EXEC_TIMEOUT_MS / 1000}s`));
    }, EXEC_TIMEOUT_MS);
    pendingExec.set(id, (msg) => {
      clearTimeout(timer);
      msg.ok ? resolve(msg.data) : reject(new Error(msg.error));
    });
    port.postMessage({ kind: "exec", id, action, args });
  });
}

async function execAny(action, args) {
  let last;
  for (const port of [...hedgePorts].reverse()) {
    try {
      return await execOn(port, action, args);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

// A close (or a scheduled open) that comes due with no papertrade tab, or none on the right coin,
// opens one in the background and runs there. Papertrade keeps its sign-in, so the new tab can trade.
const PT_ORIGIN = "https://exchange.papertrade.xyz";
const TAB_READY_MS = 30_000;
let opening = null;

function openPapertradeTab(coin) {
  opening ??= new Promise((resolve, reject) => {
    const before = new Set(hedgePorts);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Opened papertrade but it didn't load within ${TAB_READY_MS / 1000}s`));
    }, TAB_READY_MS);
    const poll = setInterval(() => {
      if (![...hedgePorts].some((p) => !before.has(p))) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 250);
    chrome.tabs.create({ url: `${PT_ORIGIN}/trade/${coin.toLowerCase()}`, active: false }).catch((err) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(err);
    });
  }).finally(() => {
    opening = null;
  });
  return opening;
}

async function exec(action, args) {
  if (hedgePorts.size) {
    try {
      return await execAny(action, args);
    } catch (err) {
      // only "wrong page" is fixed by a new tab; anything else (not signed in, ticket disabled) isn't
      if (!/^Not on papertrade's/.test(err.message)) throw err;
    }
  }
  await openPapertradeTab(args.coin);
  return { ...(await execAny(action, args)), autoOpened: true };
}

const engine = createHedgeEngine({ publish, exec });

async function loadSettings() {
  const { hedgeSettings } = await chrome.storage.local.get("hedgeSettings");
  return { ...HEDGE_DEFAULTS, ...hedgeSettings };
}

async function reconfigure() {
  try {
    await engine.configure(await loadSettings());
  } catch (err) {
    publish({ ...engine.snapshot(), alerts: [{ level: "error", text: `Setup failed: ${err.message || err}`, at: Date.now() }] });
  }
}

const COMMANDS = {
  hedgeNow: () => engine.hedgeNow("manual"),
  setAuto: ({ on }) => engine.setAuto(on),
  setLeverage: (args) => engine.setLeverage(args),
  sendToPapertrade: ({ amount }) => engine.sendToPapertrade(amount),
  scheduleRound: (spec) => engine.scheduleRound(spec),
  cancelRound: ({ id }) => engine.cancelRound(id),
  setSessionWallet: ({ address }) => engine.setSessionWallet({ address }),
  exitRound: () => engine.exitRound(),
  setPageCoin: ({ coin }) => engine.setPageCoin({ coin }),
  unlock: async ({ passphrase, hours }) => {
    const until = await unlock(passphrase, hours ?? 8);
    await engine.refreshVault();
    return { until };
  },
  setupAgent: () => engine.setupAgent(),
  forgetAgent: async () => {
    await forgetAgent();
    await engine.refreshVault();
  },
  lock: async () => {
    await lock();
    await engine.refreshVault();
  },
  storeSecret: async (args) => {
    const settings = await loadSettings();
    // fail before storing anything if the key doesn't match the configured hedge wallet
    buildSigner({ mode: args.mode, secret: args.secret }, settings.hedgeWallet);
    await storeSecret(args);
    await engine.refreshVault();
  },
  forget: async () => {
    await forget();
    await engine.refreshVault();
  },
  vaultStatus: () => vaultStatus(),
  // proves the signer works without touching funds: signs a throwaway typed-data payload
  testSigner: async () => {
    const secret = await getSecret();
    if (!secret) throw new Error("Locked");
    const settings = await loadSettings();
    const signer = buildSigner(secret, settings.hedgeWallet);
    const sig = await signer.signTypedData({
      domain: { name: "Wayfinder Papertrade Overlay", version: "1", chainId: 1337 },
      types: { Ping: [{ name: "at", type: "uint64" }] },
      primaryType: "Ping",
      message: { at: BigInt(Date.now()) },
    });
    return { address: signer.address, signature: `${sig.slice(0, 10)}…` };
  },
};

async function dispatch(cmd, args) {
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error(`Unknown command ${cmd}`);
  return fn(args ?? {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "wf-pt-hedge") return;
  hedgePorts.add(port);
  port.postMessage({ kind: "hedge", state: engine.snapshot() });
  port.onMessage.addListener(async ({ kind, id, cmd, args, ...rest }) => {
    if (kind === "execResult") {
      pendingExec.get(id)?.({ id, ...rest });
      pendingExec.delete(id);
      return;
    }
    try {
      port.postMessage({ kind: "result", id, ok: true, data: await dispatch(cmd, args) });
    } catch (err) {
      port.postMessage({ kind: "result", id, ok: false, error: String(err.message || err) });
    }
  });
  port.onDisconnect.addListener(() => hedgePorts.delete(port));
});

// options page
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "hedge") return false;
  dispatch(msg.cmd, msg.args).then(
    (data) => reply({ ok: true, data }),
    (err) => reply({ ok: false, error: String(err.message || err) }),
  );
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.hedgeSettings) return;
  if (changes.hedgeSettingsQuiet) return; // written by the engine itself (leverage change)
  reconfigure();
});

// a scheduled round sets an alarm a couple of seconds before its time, so the worker is
// awake (and resumes persisted rounds) even if nothing else kept it running
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("round:")) engine.wakeRounds();
});

reconfigure();
