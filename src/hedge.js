// Hedge engine: for every coin papertrade lists (a "lane"), keeps the Hyperliquid hedge wallet at
// −(papertrade net size) on that coin. Lanes are independent (own Tether switch, leverage, safety
// net); they share one papertrade account stream, one Hyperliquid account read, one price feed and
// one order queue. The papertrade page only decides which lane the panel shows.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildSigner, localKeySigner } from "./signers.js";
import { getAgent, getSecret, storeAgent, vaultStatus } from "./vault.js";
import { createHl, roundPrice, roundSize } from "./hl.js";
import { closedTrades, depositProxy, positionsOf, sideRoomUsd, subscribeAccount, summarize, tradingLimitsAll, winFeeRate } from "./papertrade.js";
import { planSafetyNet } from "./safetynet.js";
import { withRetry } from "./retry.js";
import { createExits } from "./exits.js";
import { createPairs } from "./pairs.js";
import { dnCost } from "./dncost.js";

export const INSTRUMENT_IDS = { BTC: 0, ETH: 1 };
const COINS = Object.keys(INSTRUMENT_IDS);
const AGENT_NAME = "paper-route"; // HL agent names are 1–16 chars; re-approving the same name replaces it
const AGENT_VALID_DAYS = 180;

export const HEDGE_DEFAULTS = {
  ptWallet: "",
  hedgeWallet: "",
  network: "mainnet",
  slippageBps: 30,
  bandUsd: 50,
  // big hedges go out as orders of at most this notional, one after another (0: one order); not a cap
  orderChunkUsd: 50_000,
  maxHedgeUsd: 0, // optional cap on the total hedge per coin (0: none; Hyperliquid's own margin check still applies)
  builderFee: true,
  marginK: 3,
  roundMarginUsd: 100,
  hlLeverage: 10, // per-coin choices live in `leverage`; this is the default for a coin not set yet
  hlCross: true,
  leverage: {}, // coin → { value, cross }
  // delta neutral per coin: hedged on Hyperliquid (Tether) or with an opposite papertrade position, covering
  // a share of the papertrade position; auto close closes both legs together
  dn: {}, // coin → { on, venue: "hl" | "pt", coverage: 0.25–1, autoClose }
  safetyNet: true,
};

// Hyperliquid account polling. The account only changes when we trade (and we re-read right after
// every order), so 3 s is plenty; prices come from the shared websocket. See hl.js for the budget.
const HL_POLL_MS = 3000;
const LIMITS_POLL_MS = 5000;
const AUTO_STABLE_MS = 400;
const AUTO_MIN_GAP_MS = 2000;
const DEPOSIT_CONFIRM_TIMEOUT_MS = 90_000;
// HL taker 4.5 bp + Wayfinder builder 2 bp + slippage headroom, as a fraction of notional
const HL_COST_FRACTION = 0.001;
// errors worth retrying rather than stopping Tether over
const TRANSIENT = /fetch failed|failed to fetch|network|timed? ?out|timeout|ECONN|ENOTFOUND|socket|\b(429|5\d\d)\b|busy|temporarily/i;
const JOB_TIMEOUT_MS = 60_000; // longest any one queued Hyperliquid action may take
const NET_RETRY_MS = 5_000; // safety-net reconcile: soonest after the last attempt
const NET_REFRESH_MS = 60_000; // …and at least this often even when nothing changed

const newLane = (coin) => ({
  coin,
  auto: false, // Tether on for this coin
  resume: false, // turn Tether back on once both feeds are live (after a restart)
  summary: null, // papertrade, this coin (summarize)
  account: null, // Hyperliquid: shared balances + this coin's position and margin
  limits: null, // papertrade trading limits for this coin
  pendingDelta: null,
  lastOrderAt: 0,
  keepAlive: null,
  net: { orders: [], error: null, at: null }, // safety net
  netBusy: false,
  netAt: 0,
  netKey: "",
});

const IO = { closedTrades, createHl, subscribeAccount, summarize, positionsOf, tradingLimitsAll, winFeeRate, depositProxy, getAgent, getSecret, storeAgent, vaultStatus };

// `io` swaps the network and key-vault calls (tests)
export function createHedgeEngine({ publish, exec, io: ioOverrides = {} }) {
  const io = { ...IO, ...ioOverrides };
  const jobTimeoutMs = ioOverrides.jobTimeoutMs ?? JOB_TIMEOUT_MS;
  let settings = { ...HEDGE_DEFAULTS };
  let hl = null;
  let meta = null; // coin → { szDecimals, maxLeverage, … }
  let stopPt = null;
  let pollTimer = null;
  let limitsTimer = null;
  let feeRate = null;
  let lastPtFrame = null;
  let viewCoin = null; // the coin the papertrade page shows
  const lanes = Object.fromEntries(COINS.map((c) => [c, newLane(c)]));
  const allLanes = () => COINS.map((c) => lanes[c]);
  const view = () => lanes[viewCoin ?? COINS[0]];

  const state = {
    vault: { unlocked: false, mode: null, remembered: false },
    pt: { status: "idle", error: null },
    hl: { status: "idle", error: null, abstraction: null },
    winFeeRate: null,
    busy: null, // label of the action in flight
    alerts: [], // newest first, { level, text, at }
    lastFill: null,
    pageCheck: null, // { ok, problems, at }: papertrade's page still has exactly one of each element Paper Route uses
  };

  const emit = () => publish(snapshot());

  function alert(level, text) {
    state.alerts = [{ level, text, at: Date.now() }, ...state.alerts].slice(0, 5);
    emit();
  }

  const DN_DEFAULT = { on: false, venue: "hl", coverage: 1, autoClose: true };
  const dnOf = (coin) => ({ ...DN_DEFAULT, ...settings.dn?.[coin] });
  // the Hyperliquid hedge covers this share of papertrade (1 unless delta neutral is set to less)
  const coverageOf = (coin) => (dnOf(coin).venue === "hl" ? dnOf(coin).coverage : 1);
  const leverageOf = (coin) => settings.leverage?.[coin] ?? { value: settings.hlLeverage, cross: settings.hlCross };
  const szDecimals = (coin) => meta[coin].szDecimals;
  const ptAvailable = () => (lastPtFrame ? Number(BigInt(lastPtFrame.funds.availableBalance)) / 1e18 : 0);
  const ptBalance = () => (lastPtFrame ? Number(BigInt(lastPtFrame.balance)) / 1e18 : 0);

  // Tether survives a worker restart: which coins it's on is saved per hedge wallet, and while any is
  // on a Hyperliquid price subscription stays open, which keeps Chrome from stopping the idle worker.
  async function saveTether() {
    const coins = Object.fromEntries(allLanes().map((l) => [l.coin, l.auto]));
    await chrome.storage.local.set({ tether: { hedgeWallet: settings.hedgeWallet, coins } });
  }
  async function setLaneOn(lane, on) {
    lane.auto = on;
    lane.pendingDelta = null;
    await saveTether();
    if (on && !lane.keepAlive && hl) lane.keepAlive = await hl.subscribeMid(lane.coin, () => {}).catch(() => null);
    if (!on) stopKeepAlive(lane);
  }
  function stopKeepAlive(lane) {
    lane.keepAlive?.();
    lane.keepAlive = null;
  }

  function failAuto(lane, reason) {
    if (lane.auto) {
      setLaneOn(lane, false);
      alert("error", `${lane.coin} Tether stopped: ${reason}`);
    } else {
      alert("error", reason);
    }
  }

  function deltaInfo(lane) {
    const pt = lane.summary;
    const acct = lane.account;
    if (!pt || !acct) return null;
    const target = -pt.netSize * coverageOf(lane.coin);
    const delta = target - acct.size;
    return { target, delta, deltaUsd: delta * acct.mid, mid: acct.mid };
  }

  const isOpen = (lane) => Math.abs(lane.summary?.netSize ?? 0) > 0 || Math.abs(lane.account?.size ?? 0) > 0;

  // the compact per-coin view for the panel's "other coins" line
  function brief(lane) {
    const d = deltaInfo(lane);
    return { coin: lane.coin, auto: lane.auto, paper: lane.summary?.netSize ?? null, hedge: lane.account?.size ?? null, deltaUsd: d?.deltaUsd ?? null, mid: lane.account?.mid ?? null, open: isOpen(lane) };
  }

  function snapshot() {
    const v = view();
    const d = deltaInfo(v);
    const lev = leverageOf(v.coin);
    return {
      ...state,
      // the panel reads these as "the coin I'm showing"
      settings: { ...settings, coin: v.coin, hlLeverage: lev.value, hlCross: lev.cross },
      pt: { ...state.pt, summary: v.summary },
      hl: { ...state.hl, account: v.account },
      auto: v.auto,
      pendingDelta: v.pendingDelta,
      safetyNet: v.net,
      delta: d,
      ptBustDist: v.summary?.bust && d ? Math.abs(v.summary.bust / d.mid - 1) : null,
      hlLiqDist: v.account?.liqPx && d ? Math.abs(v.account.liqPx / d.mid - 1) : null,
      suggestion: rebalanceSuggestion(),
      maxLeverage: meta?.[v.coin]?.maxLeverage ?? null,
      lanes: Object.fromEntries(allLanes().map((l) => [l.coin, brief(l)])),
      exits: exits.snapshot(),
      // this coin's papertrade positions, decoded, for the TP/SL editors
      ptPositions: lastPtFrame && v.account ? safePositions(v.coin, v.account.mid) : [],
      pageCoin: viewCoin,
      managing: allLanes().some((l) => l.auto && isOpen(l)) || exits.managing() || pairs.managing(),
      // on the Hyperliquid venue, delta neutral is Tether itself (set before delta neutral existed, or from the HUD)
      dn: { ...dnOf(v.coin), on: dnOf(v.coin).venue === "hl" ? v.auto : dnOf(v.coin).on },
      pairs: pairs.snapshot(),
    };
  }

  async function refreshLimits() {
    try {
      const all = await withRetry(() => io.tradingLimitsAll(), { label: "papertrade trading state" });
      for (const l of allLanes()) l.limits = all[l.coin] ?? null;
    } catch (err) {
      alert("warn", `Couldn't refresh papertrade limits: ${err.message}`);
    }
  }

  // HL needs enough equity that every hedge's liquidation sits ≥ k × that coin's papertrade bust
  // distance away; papertrade needs one trade's margin available. Whatever is left over can move.
  function rebalanceSuggestion() {
    const ready = allLanes().filter((l) => l.summary && l.account);
    if (!ready.length) return null;
    const hlRequired = ready.reduce((sum, l) => {
      const bustDist = l.summary.bust ? Math.abs(l.summary.bust / l.account.mid - 1) : 1 / 200;
      const notional = Math.max(Math.abs(l.account.size), Math.abs(l.summary.netSize)) * l.account.mid;
      return sum + notional * bustDist * settings.marginK;
    }, 0);
    const hlExcess = ready[0].account.equity - hlRequired;
    const available = ptAvailable();
    const ptShort = settings.roundMarginUsd - available;
    if (ptShort > 1 && hlExcess > 1) return { direction: "toPapertrade", amount: Math.floor(Math.min(ptShort, hlExcess)), hlRequired, hlExcess };
    if (hlExcess < -1 && available > 1) return { direction: "toHyperliquid", amount: Math.ceil(Math.min(-hlExcess, available)), hlRequired, hlExcess };
    return { direction: null, amount: 0, hlRequired, hlExcess };
  }

  // Trading actions (orders, cancels, leverage) use the always-available agent key when one is
  // approved for this wallet/network; otherwise the unlocked main key.
  async function signer() {
    const agent = await io.getAgent(settings.hedgeWallet, settings.network);
    if (agent) {
      const s = localKeySigner(agent.privateKey, agent.address);
      s.user = settings.hedgeWallet.toLowerCase(); // the account the agent trades for
      return s;
    }
    return mainSigner();
  }

  // Transfers and approvals are user-signed: only the hedge wallet's own key can do them.
  async function mainSigner() {
    const secret = await io.getSecret();
    if (!secret) throw new Error("Main key is locked — unlock it (HUD or settings) for transfers and approvals");
    return buildSigner(secret, settings.hedgeWallet);
  }

  async function canTrade() {
    return !!(await io.getAgent(settings.hedgeWallet, settings.network)) || !!(await io.getSecret());
  }

  async function ensureBuilderFeeApproved() {
    if (!settings.builderFee || (await hl.builderFeeApproved(settings.hedgeWallet))) return;
    if (!(await io.getSecret())) throw new Error("The builder fee isn't approved yet: reconnect in settings (or turn the fee off there)");
    await hl.approveBuilderFee(await mainSigner());
  }

  // One-time setup: generate an agent key here, approve it from the hedge wallet. The agent can
  // trade but never withdraw/transfer, so it's kept unlocked permanently (device-key sealed).
  // `main`: the wallet's own signer, when the user just pasted their key (Connect); otherwise the vault
  async function setupAgent(main = null) {
    if (!settings.hedgeWallet) throw new Error("Add your Hyperliquid hedge wallet first");
    // works before papertrade is open too: only Hyperliquid is involved
    const client = hl ?? io.createHl();
    return run("Setting up trading key", async () => {
      main ??= await mainSigner();
      const privateKey = generatePrivateKey();
      const { address } = privateKeyToAccount(privateKey);
      const validUntil = Date.now() + AGENT_VALID_DAYS * 86400_000;
      await client.approveAgent(main, { agentAddress: address, name: AGENT_NAME, validUntil });
      await io.storeAgent({ privateKey, address, hedgeWallet: settings.hedgeWallet, network: settings.network, validUntil });
      if (settings.builderFee && !(await client.builderFeeApproved(settings.hedgeWallet))) await client.approveBuilderFee(main);
      state.vault = await io.vaultStatus();
      alert("ok", `Trading key ${address.slice(0, 8)}… approved until ${new Date(validUntil).toLocaleDateString()}`);
      return { address, validUntil };
    });
  }

  // What the account is worth, and what could leave it. Unified / portfolio-margin accounts keep their
  // USDC in spot: flat, perps reads $0; with a position, perps mirrors the same USDC (spot shows it all
  // as held), so summing the two would double-count. Standard accounts keep them separate.
  function withTotals(acct) {
    if (state.hl.abstraction === "default") {
      return { ...acct, equity: acct.accountValue + acct.spotUsdcTotal, outable: acct.withdrawable + acct.spotUsdc };
    }
    const equity = Math.max(acct.accountValue, acct.spotUsdcTotal);
    return { ...acct, equity, outable: Math.max(0, equity - acct.marginUsed) };
  }

  // one read for every lane; `fresh`: coins about to trade (re-read their leverage / margin)
  async function readHl(fresh = []) {
    const { shared, byCoin } = await hl.accounts(settings.hedgeWallet, COINS, { fresh });
    for (const l of allLanes()) l.account = withTotals({ ...shared, ...byCoin[l.coin] });
    state.hl.status = "live";
    state.hl.error = null;
    if (lastPtFrame) for (const l of allLanes()) remarkPt(l);
  }

  async function refreshHl() {
    if (!hl || !settings.hedgeWallet) return;
    try {
      await readHl();
      for (const l of allLanes()) tryResume(l);
    } catch (err) {
      // every lane pauses (maybeAutoHedge needs both feeds live) and resumes on the next good read
      state.hl.status = "down";
      state.hl.error = String(err.message || err);
    }
    for (const l of allLanes()) maybeAutoHedge(l);
    for (const l of allLanes()) trackEpisode(l);
    settleEpisodes();
    emit();
    for (const l of allLanes()) syncSafetyNet(l);
  }

  // ---------- native safety net (src/safetynet.js), per lane ----------
  async function syncSafetyNet(lane) {
    if (lane.netBusy || !hl || !lastPtFrame || !lane.account) return;
    const acct = lane.account;
    const positions = safePositions(lane.coin, acct.mid);
    const key = JSON.stringify([settings.safetyNet, acct.size, positions.map((p) => [p.id, p.bust, p.size])]);
    const since = Date.now() - lane.netAt;
    if (since < NET_RETRY_MS || (key === lane.netKey && since < NET_REFRESH_MS)) return;
    if (!(await canTrade())) {
      lane.net = { orders: [], error: positions.length && acct.size ? "needs the trading key (or an unlocked main key)" : null, at: null };
      return;
    }
    lane.netBusy = true;
    lane.netAt = Date.now();
    const storeKey = `${settings.hedgeWallet.toLowerCase()}:${settings.network}:${lane.coin}`;
    try {
      const { safetyNetOids = {} } = await chrome.storage.local.get("safetyNetOids");
      const mine = new Set(safetyNetOids[storeKey] ?? []);
      const open = await hl.openOrders(settings.hedgeWallet, lane.coin);
      const ours = open
        .filter((o) => mine.has(o.oid))
        .map((o) => ({ oid: o.oid, triggerPx: Number(o.triggerPx), sz: Number(o.sz), closeIsBuy: o.side === "B" }));
      const dec = szDecimals(lane.coin);
      const plan = settings.safetyNet
        ? planSafetyNet({ positions, hlSize: acct.size, ours, roundSz: (v) => roundSize(v, dec), roundPx: (v) => roundPrice(v, dec) })
        : { keep: [], place: [], cancel: ours.map((o) => o.oid) };
      const s = await signer();
      if (plan.cancel.length) await hl.cancel(s, lane.coin, plan.cancel);
      const active = [...plan.keep];
      const remember = async () => {
        const { safetyNetOids: latest = {} } = await chrome.storage.local.get("safetyNetOids");
        await chrome.storage.local.set({ safetyNetOids: { ...latest, [storeKey]: active.map((o) => o.oid) } });
      };
      await remember();
      for (const d of plan.place) {
        active.push({ ...d, oid: await hl.placeTrigger(s, { coin: lane.coin, closeIsBuy: d.closeIsBuy, size: d.sz, triggerPx: d.triggerPx, tpsl: "tp" }) });
        await remember(); // one at a time, so a failure part-way never loses track of a resting order
      }
      lane.net = { orders: active.map(({ triggerPx, sz }) => ({ triggerPx, sz })), error: null, at: Date.now() };
      lane.netKey = key;
    } catch (err) {
      lane.net = { ...lane.net, error: String(err.message || err) };
      lane.netKey = "";
    } finally {
      lane.netBusy = false;
      emit();
    }
  }

  function remarkPt(lane) {
    try {
      lane.summary = io.summarize(lastPtFrame, lane.coin, lane.account.mid, state.winFeeRate ?? 0);
    } catch {
      lane.summary = null; // a price that can't be read against this mid yet: wait for the next one
    }
  }

  // ---------- a finished delta-neutral trade's cost per Paper ----------
  // Hyperliquid venue: a trade runs from the first papertrade fill on a coin until papertrade is flat again
  // and the hedge has unwound; then papertrade's paid P&L and Paper, and Hyperliquid's P&L, fees and funding
  // over that window, are summed. Papertrade venue: when both legs of a pair have closed. Only complete
  // exits get a summary: a hedge that hasn't unwound within EPISODE_SETTLE_MS doesn't.
  const EPISODE_SETTLE_MS = 90_000;
  function trackEpisode(lane) {
    if (!lane.account || !lastPtFrame) return;
    const ids = safePositions(lane.coin, lane.account.mid);
    if (!lane.auto) {
      lane.episode = null; // not hedged on Hyperliquid: not a delta-neutral trade there
      return;
    }
    if (ids.length) {
      lane.episode ??= { start: Math.min(...ids.map((p) => p.openedAtMs)), ids: new Set() };
      lane.episode.closedAt = null;
      for (const p of ids) lane.episode.ids.add(p.id);
    } else if (lane.episode && !lane.episode.closedAt) {
      lane.episode.closedAt = Date.now();
    }
  }
  function settleEpisodes() {
    for (const lane of allLanes()) {
      const ep = lane.episode;
      if (!ep?.closedAt || !lane.account) continue;
      if (roundSize(Math.abs(lane.account.size), szDecimals(lane.coin)) === 0) {
        lane.episode = null;
        summarizeTrade({ coin: lane.coin, ids: [...ep.ids], start: ep.start, venue: "hl" });
      } else if (Date.now() - ep.closedAt > EPISODE_SETTLE_MS) {
        lane.episode = null; // the hedge never unwound: not a clean exit, no summary
      }
    }
  }
  async function summarizeTrade({ coin, ids, start, venue }) {
    try {
      let pt = {};
      for (let i = 0; i < 8 && Object.keys(pt).length < ids.length; i++) {
        if (i) await new Promise((r) => setTimeout(r, 5_000)); // a close takes a few seconds to show in the history
        pt = await io.closedTrades(settings.ptWallet, ids);
      }
      if (Object.keys(pt).length < ids.length) return; // couldn't confirm every leg closed: no summary
      let hlPart = null;
      if (venue === "hl") {
        const from = (start ?? Date.now() - 3_600_000) - 10_000;
        const to = Date.now() + 5_000;
        hlPart = { fills: await hl.fills(settings.hedgeWallet, from, to), funding: await hl.funding(settings.hedgeWallet, from, to) };
      }
      const c = dnCost({ coin, pt, hl: hlPart });
      state.dnSummary = { ...c, at: Date.now() };
      const money = (v) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
      alert(
        "ok",
        `${coin} delta-neutral trade closed: ${Math.round(c.paper).toLocaleString()} Paper, net ${money(c.net)}` +
          (c.costPerPaper != null ? ` (${c.costPerPaper >= 0 ? "$" + c.costPerPaper.toFixed(4) + " per Paper" : "paid $" + (-c.costPerPaper).toFixed(4) + " per Paper"})` : ""),
      );
    } catch (err) {
      alert("warn", `Couldn't work out the cost of the ${coin} delta-neutral trade: ${err.message || err}`);
    }
  }

  function onPtFrame(frame) {
    lastPtFrame = frame;
    for (const l of allLanes()) {
      if (!l.account) continue;
      remarkPt(l);
      maybeAutoHedge(l);
      trackEpisode(l);
    }
    emit();
  }

  function onPtStatus(status, error = null) {
    state.pt.status = status;
    state.pt.error = error;
    // a dropped stream reconnects by itself (subscribeAccount); Tether pauses meanwhile and resumes on
    // the next frame, re-hedging whatever filled in between
    if (status === "live") for (const l of allLanes()) tryResume(l);
    emit();
  }

  const live = () => state.pt.status === "live" && state.hl.status === "live";

  function maybeAutoHedge(lane) {
    if (!lane.auto || state.busy || !live()) return;
    const d = deltaInfo(lane);
    if (!d || Math.abs(d.deltaUsd) <= settings.bandUsd) {
      lane.pendingDelta = null;
      return;
    }
    const now = Date.now();
    const step = 10 ** -szDecimals(lane.coin);
    if (!lane.pendingDelta || Math.abs(lane.pendingDelta.delta - d.delta) > step) {
      lane.pendingDelta = { delta: d.delta, since: now };
      setTimeout(() => maybeAutoHedge(lane), AUTO_STABLE_MS + 10);
      return;
    }
    if (now - lane.pendingDelta.since < AUTO_STABLE_MS) return;
    if (now - lane.lastOrderAt < AUTO_MIN_GAP_MS) {
      setTimeout(() => maybeAutoHedge(lane), AUTO_MIN_GAP_MS - (now - lane.lastOrderAt) + 10);
      return;
    }
    hedgeLane(lane, "auto").catch((err) => {
      const msg = String(err.message || err);
      // network trouble: stay on and try again (orders carry a cloid, so a retry can't double up)
      if (TRANSIENT.test(msg)) {
        alert("warn", `${lane.coin} hedge order didn't go through (${msg}); retrying`);
        lane.lastOrderAt = Date.now();
        setTimeout(() => maybeAutoHedge(lane), AUTO_MIN_GAP_MS + 10);
        return;
      }
      failAuto(lane, msg);
    });
  }

  // One Hyperliquid action at a time, across all lanes: queued, not refused, so BTC and ETH hedges
  // that come due together both go out, one after the other. No action may hold the queue forever:
  // one that hasn't settled after JOB_TIMEOUT_MS fails as timed out (auto-hedge retries it; network
  // calls inside have their own 8 s timeouts and orders are idempotent, so this only frees a stuck wait).
  let queue = Promise.resolve();
  function run(label, fn) {
    const job = queue.then(async () => {
      state.busy = label;
      emit();
      let timer;
      try {
        return await Promise.race([
          fn(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(jobTimeoutMs / 1000)} s`)), jobTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        state.busy = null;
        emit();
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  // Papertrade's own notional for a coin (Σ margin × leverage of its open positions), worked out apart from
  // the decoded net size the hedge target comes from: if the two disagree, something was misread.
  function ptNotionalUsd(coin, mid) {
    return safePositions(coin, mid).reduce((sum, p) => sum + p.margin * p.leverage, 0);
  }
  const SANITY_SLACK = 1.15; // price drift since entry, and rounding
  const MAX_CHUNKS = 20;

  async function hedgeLane(lane, source = "manual") {
    return run(`Hedging ${lane.coin}`, async () => {
      await readHl([lane.coin]);
      let d = deltaInfo(lane);
      if (!d) throw new Error(`Need both papertrade and Hyperliquid state to hedge ${lane.coin}`);
      const dec = szDecimals(lane.coin);
      if (roundSize(Math.abs(d.delta), dec) === 0) return null;
      const targetUsd = Math.abs(d.target) * d.mid;
      const ptUsd = ptNotionalUsd(lane.coin, d.mid);
      if (targetUsd > ptUsd * coverageOf(lane.coin) * SANITY_SLACK + 100) {
        throw new Error(`${lane.coin} hedge target $${Math.round(targetUsd).toLocaleString()} doesn't match papertrade's $${Math.round(ptUsd).toLocaleString()} of open ${lane.coin} positions, so nothing was sent. Reload papertrade; if it persists, reload Paper Route.`);
      }
      if (settings.maxHedgeUsd > 0 && targetUsd > settings.maxHedgeUsd) {
        throw new Error(`${lane.coin} hedge of $${Math.round(targetUsd).toLocaleString()} is over the max hedge of $${settings.maxHedgeUsd.toLocaleString()} you set in Paper Route's settings`);
      }
      const s = await signer();
      await ensureLeverage(lane, s);
      await ensureBuilderFeeApproved();
      const lev = leverageOf(lane.coin);
      // only the part that adds exposure needs margin; HL's availableToTrade is per side. Checked for the
      // whole hedge up front, so it never stops half way for lack of margin.
      await readHl([lane.coin]);
      d = deltaInfo(lane);
      const current = lane.account.size;
      const isBuy = d.delta > 0;
      const flipping = current !== 0 && Math.sign(d.delta) !== Math.sign(current);
      const shrinkingOnly = flipping && Math.abs(d.delta) <= Math.abs(current) + 1e-12;
      if (!shrinkingOnly) {
        const addingUsd = (flipping ? Math.abs(d.delta) - Math.abs(current) : Math.abs(d.delta)) * d.mid;
        const free = lane.account.availableToTrade[isBuy ? 0 : 1];
        const maxUsd = free / (1 / lev.value + HL_COST_FRACTION);
        if (addingUsd > maxUsd + 1) {
          throw new Error(`Hyperliquid can only carry $${Math.floor(maxUsd).toLocaleString()} more ${lane.coin} ${isBuy ? "long" : "short"} at ${lev.value}x ($${free.toFixed(2)} free); this hedge needs $${Math.ceil(addingUsd).toLocaleString()}`);
        }
      }
      // in chunks of at most orderChunkUsd, re-reading the account between them
      let last = null;
      for (let i = 0; i < MAX_CHUNKS; i++) {
        if (i > 0) {
          await readHl([lane.coin]);
          d = deltaInfo(lane);
          if (Math.abs(d.deltaUsd) <= settings.bandUsd) break;
        }
        const remaining = roundSize(Math.abs(d.delta), dec);
        if (remaining === 0) break;
        const chunkCap = settings.orderChunkUsd > 0 ? roundSize(settings.orderChunkUsd / d.mid, dec) : remaining;
        const size = Math.min(remaining, Math.max(chunkCap, 10 ** -dec));
        const pos = lane.account.size;
        const buy = d.delta > 0;
        // reduce-only when this order only shrinks the existing HL position (no flip)
        const reduceOnly = pos !== 0 && Math.sign(d.delta) !== Math.sign(pos) && size <= Math.abs(pos) + 1e-12;
        lane.lastOrderAt = Date.now();
        last = await hl.marketOrder(s, { coin: lane.coin, isBuy: buy, size, reduceOnly, slippageBps: settings.slippageBps, builderFee: settings.builderFee });
        state.lastFill = { ...last, coin: lane.coin, at: Date.now(), source };
        if (size >= remaining) break;
      }
      lane.pendingDelta = null;
      await readHl([lane.coin]);
      return last;
    });
  }

  async function ensureLeverage(lane, s) {
    const want = leverageOf(lane.coin);
    const lev = lane.account.leverage;
    if (lev.value === want.value && lev.isCross === want.cross) return;
    await hl.setLeverage(s, lane.coin, want.value, want.cross);
  }

  // picking leverage in the HUD saves it for that coin and applies it right away
  async function setLeverage({ leverage, cross, coin = view().coin }) {
    return run(`Setting ${coin} leverage`, async () => {
      const next = { ...settings, leverage: { ...settings.leverage, [coin]: { value: leverage, cross } } };
      // before setup (no wallet or locked key) just save it; ensureLeverage applies it ahead of the
      // first hedge order on that coin
      const canApply = hl && settings.hedgeWallet && (await canTrade());
      if (canApply) {
        const max = meta?.[coin]?.maxLeverage;
        if (max && leverage > max) throw new Error(`${coin} max leverage on Hyperliquid is ${max}x`);
        await hl.setLeverage(await signer(), coin, leverage, cross);
      }
      settings = next;
      await chrome.storage.local.set({ hedgeSettings: next, hedgeSettingsQuiet: Date.now() });
      if (canApply) await readHl([coin]);
    });
  }

  // `secret` ({mode, secret}): a key pasted for this one transfer, used and dropped
  async function sendToPapertrade(amount, secret = null) {
    return run("Sending to papertrade", async () => {
      if (!(amount > 0)) throw new Error("Amount must be positive");
      // transfers are user-signed; the trading key can't move funds
      const s = secret ? buildSigner(secret, settings.hedgeWallet) : await mainSigner();
      await readHl([view().coin]);
      const acct = view().account;
      // unified/portfolio accounts spend spot USDC as collateral; default accounts keep perp
      // margin separate, so move what's missing from perp to spot first
      if (state.hl.abstraction === "default" && acct.spotUsdc < amount) {
        const need = amount - acct.spotUsdc;
        if (need > acct.withdrawable) throw new Error(`Only $${acct.withdrawable.toFixed(2)} withdrawable from HL perps`);
        await hl.perpToSpot(s, need);
      }
      const before = ptBalance();
      const proxy = await io.depositProxy(settings.ptWallet);
      await hl.sendUsdc(s, proxy, amount);
      await io.depositProxy(settings.ptWallet); // nudges papertrade to index the deposit
      const credited = await waitFor(() => ptBalance() >= before + amount * 0.99, DEPOSIT_CONFIRM_TIMEOUT_MS);
      if (!credited) {
        alert("warn", `Sent $${amount} to papertrade's deposit proxy ${proxy.slice(0, 8)}… but it isn't credited yet — check papertrade before sending more`);
        return { credited: false, proxy };
      }
      alert("ok", `$${amount} deposited to papertrade`);
      return { credited: true, proxy };
    });
  }

  function waitFor(pred, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (pred()) return resolve(true);
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  // The papertrade account is the one signed in on papertrade itself (reported by the HUD from the
  // page's wallet session).
  let lastNext = {};
  let sessionWallet = null;
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

  async function setSessionWallet({ address }) {
    const addr = ADDRESS.test(address ?? "") ? address.toLowerCase() : null;
    if (addr === sessionWallet) return;
    sessionWallet = addr;
    await chrome.storage.local.set({ ptSessionWallet: addr });
    await configure(lastNext); // signed in as a different papertrade account: follow it
  }

  // the papertrade page only changes which lane the panel shows; every lane keeps running
  async function setPageCoin({ coin }) {
    const c = String(coin ?? "").toUpperCase();
    if (!(c in INSTRUMENT_IDS) || c === viewCoin) return;
    viewCoin = c;
    await chrome.storage.local.set({ ptPageCoin: c });
    emit();
  }

  function tryResume(lane) {
    if (!lane.resume || !live() || !lane.account) return;
    lane.resume = false;
    setAuto({ on: true, coin: lane.coin }).then(
      () => alert("ok", `Tether resumed on ${lane.coin}`),
      (err) => {
        setLaneOn(lane, false);
        alert("warn", `Tether not resumed on ${lane.coin}: ${err.message}`);
      },
    );
  }

  // which coins Tether was on, per hedge wallet (older versions saved one coin)
  async function savedTether() {
    const { tether } = await chrome.storage.local.get("tether");
    if (!tether || tether.hedgeWallet !== settings.hedgeWallet) return {};
    if (tether.coins) return tether.coins;
    return tether.coin ? { [tether.coin]: true } : {};
  }

  async function configure(next) {
    lastNext = next ?? {};
    if (sessionWallet === null) sessionWallet = (await chrome.storage.local.get("ptSessionWallet")).ptSessionWallet ?? null;
    if (viewCoin === null) viewCoin = (await chrome.storage.local.get("ptPageCoin")).ptPageCoin ?? null;
    settings = { ...HEDGE_DEFAULTS, ...next, network: "mainnet" }; // papertrade runs on mainnet prices only
    // always the account signed in on papertrade (an override saved by an older version is ignored)
    settings.ptWallet = sessionWallet ?? "";
    settings.ptWalletFromSession = true;
    for (const l of allLanes()) {
      stopKeepAlive(l);
      Object.assign(l, newLane(l.coin));
    }
    const on = await savedTether();
    for (const l of allLanes()) l.resume = !!on[l.coin];
    stopPt?.();
    clearInterval(pollTimer);
    clearInterval(limitsTimer);
    state.pt = { status: "idle", error: null };
    lastPtFrame = null;
    state.hl = { status: "idle", error: null, abstraction: null };
    state.vault = await io.vaultStatus();
    emit();
    hl = null;
    if (!settings.ptWallet) return;
    stopPt = io.subscribeAccount(settings.ptWallet, { onFrame: onPtFrame, onStatus: onPtStatus });
    await refreshLimits();
    limitsTimer = setInterval(refreshLimits, LIMITS_POLL_MS);
    if (!settings.hedgeWallet) return;
    hl = io.createHl();
    meta = await hl.loadMeta();
    state.winFeeRate = feeRate ??= await io.winFeeRate();
    // papertrade's own mapping: anything that isn't unified/portfolio margin behaves as "default"
    const mode = await hl.abstraction(settings.hedgeWallet);
    state.hl.abstraction = mode === "unifiedAccount" || mode === "portfolioMargin" ? mode : "default";
    pollTimer = setInterval(refreshHl, HL_POLL_MS);
    await refreshHl();
  }

  async function setAuto({ on, coin = view().coin }) {
    const lane = lanes[coin];
    if (!lane) throw new Error(`Unknown coin ${coin}`);
    if (on) {
      if (!(await canTrade())) throw new Error("Connect your Hyperliquid wallet before turning on Tether");
      if (!live()) throw new Error("Both papertrade and Hyperliquid must be live");
    }
    await setLaneOn(lane, on);
    const dn = dnOf(coin);
    if (on) await saveDn(coin, { ...dn, on: true, venue: "hl" });
    else if (dn.venue === "hl" && dn.on) await saveDn(coin, { ...dn, on: false });
    emit();
    if (on) maybeAutoHedge(lane);
  }

  async function saveDn(coin, next) {
    settings = { ...settings, dn: { ...settings.dn, [coin]: next } };
    await chrome.storage.local.set({ hedgeSettings: settings, hedgeSettingsQuiet: Date.now() });
  }

  // the order ticket's delta-neutral controls
  async function setDeltaNeutral({ coin = view().coin, on, venue, coverage, autoClose }) {
    const lane = lanes[coin];
    if (!lane) throw new Error(`Unknown coin ${coin}`);
    const next = { ...dnOf(coin) };
    if (on !== undefined) next.on = !!on;
    if (venue !== undefined) {
      if (venue !== "hl" && venue !== "pt") throw new Error(`Unknown venue ${venue}`);
      next.venue = venue;
    }
    if (coverage !== undefined) {
      if (!(coverage > 0 && coverage <= 1)) throw new Error("Coverage must be between 0 and 100%");
      next.coverage = coverage;
    }
    if (autoClose !== undefined) next.autoClose = !!autoClose;
    if (next.on && next.venue === "hl") {
      if (!(await canTrade())) throw new Error("Connect your Hyperliquid wallet to hedge there (toolbar icon → Connect)");
      if (!live()) throw new Error("Both papertrade and Hyperliquid must be live");
      await setLaneOn(lane, true);
    } else if (lane.auto) {
      await setLaneOn(lane, false); // hedging with papertrade itself, or off: Hyperliquid isn't touched
    }
    await saveDn(coin, next);
    emit();
    if (lane.auto) maybeAutoHedge(lane);
    return next;
  }

  // the ticket is placing a main order and its opposite papertrade hedge: pair them when they fill
  async function armPair({ coin, mainIsLong }) {
    await pairsReady;
    pairs.arm({ coin, mainIsLong });
  }

  // "Close both": a papertrade pair closes both legs; with the Hyperliquid venue, closing papertrade is
  // enough (Tether closes the hedge when that close fills)
  async function closeBoth({ positionId, coin }) {
    await pairsReady;
    if (await pairs.closePair(positionId)) return { pair: true };
    await exec("ptClose", { positionId: String(positionId), coin });
    return { pair: false };
  }

  async function hedgeNow({ coin = view().coin } = {}) {
    return hedgeLane(lanes[coin], "manual");
  }

  async function refreshVault() {
    state.vault = await io.vaultStatus();
    if (!(await canTrade())) for (const l of allLanes()) if (l.auto) failAuto(l, "no trading key and the main key is locked");
    emit();
  }

  function safePositions(coin, mid) {
    try {
      return io.positionsOf(lastPtFrame, coin, mid);
    } catch {
      return []; // a price we can't decode against this mid (mid not loaded yet)
    }
  }

  const laneMids = (mids) => ({ ...mids, ...Object.fromEntries(allLanes().filter((l) => l.account).map((l) => [l.coin, l.account.mid])) });
  const exits = createExits({
    positions: (mids) => {
      if (!lastPtFrame) return [];
      const known = laneMids(mids);
      return COINS.flatMap((coin) => (known[coin] ? safePositions(coin, known[coin]) : []));
    },
    readableCoins: (mids) => {
      if (!lastPtFrame) return [];
      const known = laneMids(mids);
      return COINS.filter((coin) => known[coin]);
    },
    closeQueued: (id) => (lastPtFrame?.operations ?? []).some((op) => op[1] === "closePositions" && (op[9] ?? []).map(String).includes(id)),
    // op = [intentId, action, instrumentId, isLong, …]
    openQueued: (coin, isLong) => (lastPtFrame?.operations ?? []).some((op) => op[1] === "openPosition" && Number(op[2]) === INSTRUMENT_IDS[coin] && !!op[3] === isLong),
    ptLive: () => state.pt.status === "live" && !!lastPtFrame,
    subscribeMid: (coin, fn) => (hl ?? io.createHl()).subscribeMid(coin, fn),
    mid: (coin) => (hl ?? io.createHl()).mid(coin),
    exec,
    alert: (level, text) => alert(level, text),
    emit: () => emit(),
    // a stop loss / take profit fired: both legs close with auto close; without it the hedge is left to run
    onExitHit: (positionId, coin, reason) => {
      pairs.onExitHit(positionId, reason);
      const dn = dnOf(coin);
      if (!dn.autoClose && dn.venue === "hl" && lanes[coin]?.auto) {
        setLaneOn(lanes[coin], false);
        alert("warn", `${coin} ${reason}: closing the papertrade position only. Tether is now off for ${coin}, so the Hyperliquid hedge stays open (auto close is off)`);
      }
    },
  });
  const exitsReady = exits.init();
  const pairs = createPairs({
    positions: () => (lastPtFrame ? COINS.flatMap((coin) => (lanes[coin].account ? safePositions(coin, lanes[coin].account.mid) : [])) : []),
    readableCoins: () => (lastPtFrame ? COINS.filter((coin) => lanes[coin].account) : []),
    openQueued: (coin, isLong) => (lastPtFrame?.operations ?? []).some((op) => op[1] === "openPosition" && Number(op[2]) === INSTRUMENT_IDS[coin] && !!op[3] === isLong),
    closeQueued: (id) => (lastPtFrame?.operations ?? []).some((op) => op[1] === "closePositions" && (op[9] ?? []).map(String).includes(id)),
    ptLive: () => state.pt.status === "live" && !!lastPtFrame,
    autoClose: (coin) => dnOf(coin).autoClose,
    onDone: ({ coin, ids, openedAt }) => summarizeTrade({ coin, ids, start: openedAt, venue: "pt" }),
    exec,
    alert: (level, text) => alert(level, text),
    emit: () => emit(),
  });
  const pairsReady = pairs.init();

  // the papertrade tab's self-check; alert on each change, so a papertrade update that moves its buttons
  // is noticed before a stop loss or take profit needs them
  function setPageCheck({ ok, problems = [] }) {
    const was = state.pageCheck;
    state.pageCheck = { ok: !!ok, problems, at: Date.now() };
    const changed = !was || was.ok !== !!ok || JSON.stringify(was.problems) !== JSON.stringify(problems);
    if (changed && !ok) alert("error", `Papertrade's page changed (${problems.join("; ")}). Stop loss / take profit may not be able to close positions: watch them, or close by hand.`);
    else if (changed && ok && was && !was.ok) alert("ok", "Papertrade's page check passes again");
    else if (changed) emit();
  }

  async function setExit(args) {
    await exitsReady;
    return exits.set(args);
  }

  async function armExit(args) {
    await exitsReady;
    return exits.arm({ coin: view().coin, ...args });
  }

  return { setDeltaNeutral, armPair, closeBoth, setPageCheck, setExit, armExit, configure, hedgeNow, setAuto, setLeverage, sendToPapertrade, refreshVault, snapshot, emit, setupAgent, setSessionWallet, setPageCoin, coin: () => view().coin, coins: () => COINS };
}
