// Hedge engine: keeps the HL hedge wallet at -(papertrade net size) on the same coin.
// Auto-hedge fails hard: any error, a down papertrade stream, or a failed HL read turns it
// off and raises an alert rather than retrying.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildSigner, localKeySigner } from "./signers.js";
import { getAgent, getSecret, storeAgent, vaultStatus } from "./vault.js";
import { createHl, roundPrice, roundSize } from "./hl.js";
import { decodePrice, depositProxy, positionsOf, sideRoomUsd, subscribeAccount, summarize, tradingLimits, winFeeRate } from "./papertrade.js";
import { planSafetyNet } from "./safetynet.js";
import { HL_COST_FRACTION, roundCapacity } from "./capacity.js";
import { withRetry } from "./retry.js";
import { createRounds } from "./rounds.js";

export const INSTRUMENT_IDS = { BTC: 0, ETH: 1 };
const AGENT_NAME = "paper-route"; // HL agent names are 1–16 chars; re-approving the same name replaces it
const AGENT_VALID_DAYS = 180;

export const HEDGE_DEFAULTS = {
  coin: "BTC",
  ptWallet: "",
  hedgeWallet: "",
  network: "mainnet",
  slippageBps: 30,
  bandUsd: 50,
  maxOrderUsd: 25_000,
  maxPositionUsd: 50_000,
  builderFee: true,
  marginK: 3,
  roundMarginUsd: 100,
  hlLeverage: 10,
  hlCross: true,
  safetyNet: true,
};

const HL_POLL_MS = 1000;
const LIMITS_POLL_MS = 5000;
const AUTO_STABLE_MS = 400;
const AUTO_MIN_GAP_MS = 2000;
const DEPOSIT_CONFIRM_TIMEOUT_MS = 90_000;
const NET_RETRY_MS = 5_000; // safety-net reconcile: soonest after the last attempt
const NET_REFRESH_MS = 30_000; // …and at least this often even when nothing changed

export function createHedgeEngine({ publish, exec }) {
  let settings = { ...HEDGE_DEFAULTS };
  let hl = null;
  let szDecimals = null;
  let stopPt = null;
  let pollTimer = null;
  let feeRate = null;
  let lastPtFrame = null;
  let maxLeverage = null;
  let ptLimits = null; // papertrade /state/trading limits, refreshed every LIMITS_POLL_MS
  let limitsTimer = null;

  const state = {
    settings,
    vault: { unlocked: false, mode: null, remembered: false },
    pt: { status: "idle", error: null, summary: null },
    hl: { status: "idle", error: null, account: null, abstraction: null },
    winFeeRate: null,
    auto: false,
    busy: null, // label of the action in flight
    alerts: [], // newest first, { level, text, at }
    lastFill: null,
    pendingDelta: null, // { delta, since }
    lastOrderAt: 0,
    hold: false, // a round is closing papertrade: don't re-hedge into the move
    safetyNet: { orders: [], error: null, at: null },
  };

  const emit = () => publish(snapshot());

  function alert(level, text) {
    state.alerts = [{ level, text, at: Date.now() }, ...state.alerts].slice(0, 5);
    emit();
  }

  // Tether survives a worker restart: its on/off is saved per coin + hedge wallet, and while it's on a
  // Hyperliquid price socket stays open, which keeps Chrome from stopping the idle worker.
  let keepAlive = null;
  async function setTetherOn(on) {
    await chrome.storage.local.set({ tether: on ? { coin: settings.coin, hedgeWallet: settings.hedgeWallet } : null });
    if (on && !keepAlive && hl) keepAlive = await hl.subscribeMid(settings.coin, () => {}).catch(() => null);
    if (!on) stopKeepAlive();
  }
  function stopKeepAlive() {
    keepAlive?.();
    keepAlive = null;
  }

  function failAuto(reason) {
    if (state.auto) {
      state.auto = false;
      setTetherOn(false);
      alert("error", `Tether stopped: ${reason}`);
    } else {
      alert("error", reason);
    }
  }

  function deltaInfo() {
    const pt = state.pt.summary;
    const acct = state.hl.account;
    if (!pt || !acct) return null;
    const target = -pt.netSize;
    const delta = target - acct.size;
    return { target, delta, deltaUsd: delta * acct.mid, mid: acct.mid };
  }

  function snapshot() {
    const d = deltaInfo();
    return {
      ...state,
      settings,
      delta: d,
      ptBustDist: state.pt.summary?.bust && d ? Math.abs(state.pt.summary.bust / d.mid - 1) : null,
      hlLiqDist: state.hl.account?.liqPx && d ? Math.abs(state.hl.account.liqPx / d.mid - 1) : null,
      suggestion: rebalanceSuggestion(),
      maxLeverage,
      rounds: rounds.snapshot(),
      pageCoin,
      managing: rounds.managing() || !!tetheredCoin(),
      lockedBy: pageCoin && pageCoin !== settings.coin ? (rounds.lockedCoin() ? "round" : tetheredCoin() ? "tether" : null) : null,
      capacityInputs: capacityInputs(),
    };
  }

  // Everything the max-size calculation needs, from live balances on both venues.
  // null until both papertrade and Hyperliquid have reported.
  function capacityInputs() {
    const acct = state.hl.account;
    if (!ptLimits || !acct || !lastPtFrame) return null;
    const { oi, ...limits } = ptLimits;
    return {
      ptAvailable: Number(BigInt(lastPtFrame.funds.availableBalance)) / 1e18,
      ptLimits: { ...limits, roomLongUsd: sideRoomUsd(ptLimits, true, acct.mid), roomShortUsd: sideRoomUsd(ptLimits, false, acct.mid) },
      hlAvailableToTrade: acct.availableToTrade,
      hlLeverage: settings.hlLeverage,
      hlMaxLeverage: maxLeverage,
      maxOrderUsd: settings.maxOrderUsd,
      maxPositionUsd: settings.maxPositionUsd,
      mid: acct.mid,
    };
  }

  function capacity(isPaperLong, ptLeverage, hedge) {
    const inp = capacityInputs();
    if (!inp) throw new Error("Waiting for papertrade and Hyperliquid balances");
    return roundCapacity({
      ...inp,
      isPaperLong,
      ptLeverage,
      hedge,
      ptLimits: { ...inp.ptLimits, sideRoomUsd: isPaperLong ? inp.ptLimits.roomLongUsd : inp.ptLimits.roomShortUsd },
    });
  }

  async function refreshLimits() {
    try {
      ptLimits = await withRetry(() => tradingLimits(settings.coin), { label: "papertrade trading state" });
    } catch (err) {
      alert("warn", `Couldn't refresh papertrade limits: ${err.message}`);
    }
  }

  // HL needs enough equity that its liquidation sits >= k x papertrade's bust distance away;
  // papertrade needs one round of margin available. Whatever is left over can move.
  function rebalanceSuggestion() {
    const pt = state.pt.summary;
    const acct = state.hl.account;
    if (!pt || !acct) return null;
    const bustDist = pt.bust ? Math.abs(pt.bust / acct.mid - 1) : 1 / 200;
    const hlNotional = Math.max(Math.abs(acct.size), Math.abs(pt.netSize)) * acct.mid;
    const hlRequired = hlNotional * bustDist * settings.marginK;
    const hlEquity = acct.accountValue + (state.hl.abstraction === "default" ? acct.spotUsdc : 0);
    const hlExcess = hlEquity - hlRequired;
    const ptShort = settings.roundMarginUsd - pt.available;
    if (ptShort > 1 && hlExcess > 1) return { direction: "toPapertrade", amount: Math.floor(Math.min(ptShort, hlExcess)), hlRequired, hlExcess };
    if (hlExcess < -1 && pt.available > 1) return { direction: "toHyperliquid", amount: Math.ceil(Math.min(-hlExcess, pt.available)), hlRequired, hlExcess };
    return { direction: null, amount: 0, hlRequired, hlExcess };
  }

  // Trading actions (orders, cancels, leverage) use the always-available agent key when one is
  // approved for this wallet/network; otherwise the unlocked main key.
  async function signer() {
    const agent = await getAgent(settings.hedgeWallet, settings.network);
    if (agent) {
      const s = localKeySigner(agent.privateKey, agent.address);
      s.user = settings.hedgeWallet.toLowerCase(); // the account the agent trades for
      return s;
    }
    return mainSigner();
  }

  // Transfers and approvals are user-signed: only the hedge wallet's own key can do them.
  async function mainSigner() {
    const secret = await getSecret();
    if (!secret) throw new Error("Main key is locked — unlock it (HUD or settings) for transfers and approvals");
    return buildSigner(secret, settings.hedgeWallet);
  }

  async function canTrade() {
    return !!(await getAgent(settings.hedgeWallet, settings.network)) || !!(await getSecret());
  }

  async function ensureBuilderFeeApproved() {
    if (!settings.builderFee || (await hl.builderFeeApproved(settings.hedgeWallet))) return;
    if (!(await getSecret())) throw new Error("Unlock your main key once to approve the Wayfinder builder fee (or turn it off in settings)");
    await hl.approveBuilderFee(await mainSigner());
  }

  // One-time setup: generate an agent key here, approve it from the hedge wallet. The agent can
  // trade but never withdraw/transfer, so it's kept unlocked permanently (device-key sealed).
  async function setupAgent() {
    if (!hl) throw new Error("Set the papertrade and hedge wallets first");
    return run("Setting up trading key", async () => {
      const main = await mainSigner();
      const privateKey = generatePrivateKey();
      const { address } = privateKeyToAccount(privateKey);
      const validUntil = Date.now() + AGENT_VALID_DAYS * 86400_000;
      await hl.approveAgent(main, { agentAddress: address, name: AGENT_NAME, validUntil });
      await storeAgent({ privateKey, address, hedgeWallet: settings.hedgeWallet, network: settings.network, validUntil });
      if (settings.builderFee && !(await hl.builderFeeApproved(settings.hedgeWallet))) await hl.approveBuilderFee(main);
      state.vault = await vaultStatus();
      alert("ok", `Trading key ${address.slice(0, 8)}… approved until ${new Date(validUntil).toLocaleDateString()}`);
      return { address, validUntil };
    });
  }

  async function refreshHl() {
    if (!hl || !settings.hedgeWallet) return;
    try {
      state.hl.account = await hl.account(settings.hedgeWallet, settings.coin);
      state.hl.status = "live";
      state.hl.error = null;
      tryResumeAuto();
    } catch (err) {
      state.hl.status = "down";
      state.hl.error = String(err.message || err);
      if (state.auto) failAuto(`Hyperliquid read failed (${state.hl.error})`);
    }
    // re-mark papertrade P&L at the latest mid between stream frames
    if (lastPtFrame && state.hl.account) remarkPt();
    maybeAutoHedge();
    emit();
    followPageCoin();
    syncSafetyNet();
  }

  // ---------- native safety net (src/safetynet.js) ----------
  let netBusy = false;
  let netAt = 0;
  let netKey = "";

  async function syncSafetyNet() {
    if (netBusy || !hl || !lastPtFrame || !state.hl.account) return;
    const acct = state.hl.account;
    const positions = positionsOf(lastPtFrame, settings.coin, acct.mid);
    const key = JSON.stringify([settings.safetyNet, acct.size, positions.map((p) => [p.id, p.bust, p.size])]);
    const since = Date.now() - netAt;
    if (since < NET_RETRY_MS || (key === netKey && since < NET_REFRESH_MS)) return;
    if (!(await canTrade())) {
      state.safetyNet = { orders: [], error: positions.length && acct.size ? "needs the trading key (or an unlocked main key)" : null, at: null };
      return;
    }
    netBusy = true;
    netAt = Date.now();
    const storeKey = `${settings.hedgeWallet.toLowerCase()}:${settings.network}:${settings.coin}`;
    try {
      const { safetyNetOids = {} } = await chrome.storage.local.get("safetyNetOids");
      const mine = new Set(safetyNetOids[storeKey] ?? []);
      const open = await hl.openOrders(settings.hedgeWallet, settings.coin);
      const ours = open
        .filter((o) => mine.has(o.oid))
        .map((o) => ({ oid: o.oid, triggerPx: Number(o.triggerPx), sz: Number(o.sz), closeIsBuy: o.side === "B" }));
      const plan = settings.safetyNet
        ? planSafetyNet({ positions, hlSize: acct.size, ours, roundSz: (v) => roundSize(v, szDecimals), roundPx: (v) => roundPrice(v, szDecimals) })
        : { keep: [], place: [], cancel: ours.map((o) => o.oid) };
      const s = await signer();
      if (plan.cancel.length) await hl.cancel(s, settings.coin, plan.cancel);
      const active = [...plan.keep];
      const remember = () => chrome.storage.local.set({ safetyNetOids: { ...safetyNetOids, [storeKey]: active.map((o) => o.oid) } });
      await remember();
      for (const d of plan.place) {
        active.push({ ...d, oid: await hl.placeTrigger(s, { coin: settings.coin, closeIsBuy: d.closeIsBuy, size: d.sz, triggerPx: d.triggerPx, tpsl: "tp" }) });
        await remember(); // one at a time, so a failure part-way never loses track of a resting order
      }
      state.safetyNet = { orders: active.map(({ triggerPx, sz }) => ({ triggerPx, sz })), error: null, at: Date.now() };
      netKey = key;
    } catch (err) {
      state.safetyNet = { ...state.safetyNet, error: String(err.message || err) };
      netKey = "";
    } finally {
      netBusy = false;
      emit();
    }
  }

  function remarkPt() {
    try {
      state.pt.summary = summarize(lastPtFrame, settings.coin, state.hl.account.mid, state.winFeeRate ?? 0);
    } catch (err) {
      state.pt.summary = null;
      failAuto(String(err.message || err));
    }
  }

  function onPtFrame(frame) {
    lastPtFrame = frame;
    if (!state.hl.account) {
      emit();
      return;
    }
    remarkPt();
    maybeAutoHedge();
    emit();
  }

  function onPtStatus(status, error = null) {
    state.pt.status = status;
    state.pt.error = error;
    if (status === "live") tryResumeAuto();
    if (status === "down" && state.auto) failAuto(`papertrade stream down (${error})`);
    emit();
  }

  function maybeAutoHedge() {
    if (!state.auto || state.hold || state.busy || state.pt.status !== "live" || state.hl.status !== "live") return;
    const d = deltaInfo();
    if (!d || Math.abs(d.deltaUsd) <= settings.bandUsd) {
      state.pendingDelta = null;
      return;
    }
    const now = Date.now();
    const step = 10 ** -szDecimals;
    if (!state.pendingDelta || Math.abs(state.pendingDelta.delta - d.delta) > step) {
      state.pendingDelta = { delta: d.delta, since: now };
      setTimeout(maybeAutoHedge, AUTO_STABLE_MS + 10);
      return;
    }
    if (now - state.pendingDelta.since < AUTO_STABLE_MS) return;
    if (now - state.lastOrderAt < AUTO_MIN_GAP_MS) {
      setTimeout(maybeAutoHedge, AUTO_MIN_GAP_MS - (now - state.lastOrderAt) + 10);
      return;
    }
    hedgeNow("auto").catch((err) => failAuto(String(err.message || err)));
  }

  async function run(label, fn) {
    if (state.busy) throw new Error(`Busy: ${state.busy}`);
    state.busy = label;
    emit();
    try {
      return await fn();
    } finally {
      state.busy = null;
      emit();
    }
  }

  async function hedgeNow(source = "manual") {
    return run(source === "auto" ? "Auto-hedging" : "Hedging", async () => {
      await refreshHlQuiet();
      const d = deltaInfo();
      if (!d) throw new Error("Need both papertrade and Hyperliquid state to hedge");
      const size = roundSize(Math.abs(d.delta), szDecimals);
      if (size === 0) return null;
      const orderUsd = size * d.mid;
      if (orderUsd > settings.maxOrderUsd) throw new Error(`Hedge order $${orderUsd.toFixed(0)} exceeds max order $${settings.maxOrderUsd}`);
      if (Math.abs(d.target) * d.mid > settings.maxPositionUsd) throw new Error(`Target hedge $${(Math.abs(d.target) * d.mid).toFixed(0)} exceeds max position $${settings.maxPositionUsd}`);
      const current = state.hl.account.size;
      const isBuy = d.delta > 0;
      // reduce-only when the order only shrinks the existing HL position (no flip)
      const reduceOnly = current !== 0 && Math.sign(d.delta) !== Math.sign(current) && Math.abs(d.delta) <= Math.abs(current) + 1e-12;
      state.lastOrderAt = Date.now();
      const s = await signer();
      await ensureLeverage(s);
      await ensureBuilderFeeApproved();
      if (!reduceOnly) {
        // only the part that adds exposure needs margin; HL's availableToTrade is per side
        await refreshHlQuiet();
        const flipping = current !== 0 && Math.sign(d.delta) !== Math.sign(current);
        const addingUsd = (flipping ? size - Math.abs(current) : size) * d.mid;
        const free = state.hl.account.availableToTrade[isBuy ? 0 : 1];
        const maxUsd = free / (1 / settings.hlLeverage + HL_COST_FRACTION);
        if (addingUsd > maxUsd + 1) {
          throw new Error(`Hyperliquid can only carry $${Math.floor(maxUsd).toLocaleString()} more ${isBuy ? "long" : "short"} at ${settings.hlLeverage}x ($${free.toFixed(2)} free); this hedge needs $${Math.ceil(addingUsd).toLocaleString()}`);
        }
      }
      const fill = await hl.marketOrder(s, {
        coin: settings.coin,
        isBuy,
        size,
        reduceOnly,
        slippageBps: settings.slippageBps,
        builderFee: settings.builderFee,
      });
      state.lastFill = { ...fill, at: Date.now(), source };
      state.pendingDelta = null;
      await refreshHlQuiet();
      return fill;
    });
  }

  async function ensureLeverage(s) {
    const lev = state.hl.account.leverage;
    if (lev.value === settings.hlLeverage && lev.isCross === settings.hlCross) return;
    await hl.setLeverage(s, settings.coin, settings.hlLeverage, settings.hlCross);
  }

  // picking leverage in the HUD saves it and applies it right away
  async function setLeverage({ leverage, cross }) {
    return run("Setting leverage", async () => {
      const next = { ...settings, hlLeverage: leverage, hlCross: cross };
      // before setup (no wallet or locked key) just save it; ensureLeverage applies it on HL
      // ahead of the first hedge order
      const canApply = hl && settings.hedgeWallet && (await canTrade());
      if (canApply) {
        if (maxLeverage && leverage > maxLeverage) throw new Error(`${settings.coin} max leverage on Hyperliquid is ${maxLeverage}x`);
        await refreshHlQuiet();
        await hl.setLeverage(await signer(), settings.coin, leverage, cross);
      }
      settings = next;
      await chrome.storage.local.set({ hedgeSettings: next, hedgeSettingsQuiet: Date.now() });
      if (canApply) await refreshHlQuiet();
    });
  }

  async function refreshHlQuiet() {
    state.hl.account = await hl.account(settings.hedgeWallet, settings.coin);
    state.hl.status = "live";
  }

  async function sendToPapertrade(amount) {
    return run("Sending to papertrade", async () => {
      if (!(amount > 0)) throw new Error("Amount must be positive");
      const s = await mainSigner(); // transfers are user-signed; the trading key can't move funds
      await refreshHlQuiet();
      const acct = state.hl.account;
      // unified/portfolio accounts spend spot USDC as collateral; default accounts keep perp
      // margin separate, so move what's missing from perp to spot first
      if (state.hl.abstraction === "default" && acct.spotUsdc < amount) {
        const need = amount - acct.spotUsdc;
        if (need > acct.withdrawable) throw new Error(`Only $${acct.withdrawable.toFixed(2)} withdrawable from HL perps`);
        await hl.perpToSpot(s, need);
      }
      const before = state.pt.summary?.balance ?? 0;
      const proxy = await depositProxy(settings.ptWallet);
      await hl.sendUsdc(s, proxy, amount);
      await depositProxy(settings.ptWallet); // nudges papertrade to index the deposit
      const credited = await waitFor(() => (state.pt.summary?.balance ?? 0) >= before + amount * 0.99, DEPOSIT_CONFIRM_TIMEOUT_MS);
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

  // The papertrade wallet defaults to the account signed in on papertrade itself (reported by the
  // HUD from the page's wallet session); a wallet saved in settings overrides it.
  let lastNext = {};
  let sessionWallet = null;
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

  async function setSessionWallet({ address }) {
    const addr = ADDRESS.test(address ?? "") ? address.toLowerCase() : null;
    if (addr === sessionWallet) return;
    sessionWallet = addr;
    await chrome.storage.local.set({ ptSessionWallet: addr });
    // only matters when settings don't name a wallet; then reconnect papertrade as that account
    if (!lastNext.ptWallet) await configure(lastNext);
  }

  // The coin follows the papertrade page (/trade/btc, /trade/eth), but a round that's still
  // running keeps the engine on its own coin until it's done.
  let pageCoin = null;
  let switching = false;

  async function setPageCoin({ coin }) {
    const c = String(coin ?? "").toUpperCase();
    if (!(c in INSTRUMENT_IDS) || c === pageCoin) return;
    pageCoin = c;
    await chrome.storage.local.set({ ptPageCoin: c });
    await followPageCoin();
    emit();
  }

  // while auto-hedge is tethering an open position, the engine stays on that coin
  function tetheredCoin() {
    if (!state.auto) return null;
    const open = Math.abs(state.pt.summary?.netSize ?? 0) > 0 || Math.abs(state.hl.account?.size ?? 0) > 0;
    return open ? settings.coin : null;
  }

  async function followPageCoin() {
    if (switching || !pageCoin || pageCoin === settings.coin) return;
    await (roundsReady ??= rounds.init());
    if (rounds.lockedCoin() || tetheredCoin()) return;
    switching = true;
    const keepAuto = state.auto;
    try {
      await configure(lastNext);
      resumeAuto = keepAuto;
      tryResumeAuto();
    } finally {
      switching = false;
    }
  }

  let resumeAuto = false;
  function tryResumeAuto() {
    if (!resumeAuto || state.pt.status !== "live" || state.hl.status !== "live") return;
    resumeAuto = false;
    setAuto(true).then(
      () => alert("ok", `Tether resumed on ${settings.coin}`),
      (err) => {
        setTetherOn(false);
        alert("warn", `Tether not resumed on ${settings.coin}: ${err.message}`);
      },
    );
  }

  async function configure(next) {
    lastNext = next ?? {};
    if (sessionWallet === null) sessionWallet = (await chrome.storage.local.get("ptSessionWallet")).ptSessionWallet ?? null;
    if (pageCoin === null) pageCoin = (await chrome.storage.local.get("ptPageCoin")).ptPageCoin ?? null;
    await (roundsReady ??= rounds.init());
    settings = { ...HEDGE_DEFAULTS, ...next, network: "mainnet" }; // papertrade runs on mainnet prices only
    settings.coin = rounds.lockedCoin() ?? pageCoin ?? settings.coin;
    if (!settings.ptWallet && sessionWallet) {
      settings.ptWallet = sessionWallet;
      settings.ptWalletFromSession = true;
    }
    state.auto = false;
    stopKeepAlive();
    const { tether } = await chrome.storage.local.get("tether");
    resumeAuto = !!tether && tether.coin === settings.coin && tether.hedgeWallet === settings.hedgeWallet;
    stopPt?.();
    clearInterval(pollTimer);
    clearInterval(limitsTimer);
    ptLimits = null;
    state.pt = { status: "idle", error: null, summary: null };
    lastPtFrame = null;
    state.hl = { status: "idle", error: null, account: null, abstraction: null };
    state.vault = await vaultStatus();
    emit();
    hl = null;
    if (!settings.ptWallet) return;
    stopPt = subscribeAccount(settings.ptWallet, { onFrame: onPtFrame, onStatus: onPtStatus });
    await refreshLimits();
    limitsTimer = setInterval(refreshLimits, LIMITS_POLL_MS);
    if (!settings.hedgeWallet) return;
    hl = createHl();
    const meta = await hl.loadMeta();
    szDecimals = meta[settings.coin].szDecimals;
    maxLeverage = meta[settings.coin].maxLeverage;
    state.winFeeRate = feeRate ??= await winFeeRate();
    // papertrade's own mapping: anything that isn't unified/portfolio margin behaves as "default"
    const mode = await hl.abstraction(settings.hedgeWallet);
    state.hl.abstraction = mode === "unifiedAccount" || mode === "portfolioMargin" ? mode : "default";
    pollTimer = setInterval(refreshHl, HL_POLL_MS);
    await refreshHl();
    await wakeRounds(); // resume any round persisted before a worker restart
  }

  async function setAuto(on) {
    if (on) {
      if (!(await canTrade())) throw new Error("Set up the trading key (or unlock the main key) before turning on Tether");
      if (state.pt.status !== "live" || state.hl.status !== "live") throw new Error("Both papertrade and Hyperliquid must be live");
    }
    state.auto = on;
    state.pendingDelta = null;
    await setTetherOn(on);
    emit();
    if (on) maybeAutoHedge();
  }

  async function refreshVault() {
    state.vault = await vaultStatus();
    if (state.auto && !(await canTrade())) failAuto("no trading key and the main key is locked");
    emit();
  }

  let roundsReady = null;
  const rounds = createRounds({
    hl: () => {
      if (!hl) throw new Error("Hedge isn't configured");
      return hl;
    },
    signer,
    coin: () => settings.coin,
    instrumentId: () => INSTRUMENT_IDS[settings.coin],
    hedgeWallet: () => settings.hedgeWallet,
    bandUsd: () => settings.bandUsd,
    ptFrame: () => lastPtFrame,
    ptLive: () => state.pt.status === "live" && !!lastPtFrame,
    hlAccount: () => state.hl.account,
    delta: () => deltaInfo(),
    decodePrice: (raw) => decodePrice(raw, state.hl.account.mid),
    refreshHl: async () => {
      await refreshHlQuiet();
      if (lastPtFrame) remarkPt();
      return state.hl.account;
    },
    hedgeNow: (source) => hedgeNow(source),
    setHold: (on) => {
      state.hold = on;
    },
    capacity: (isPaperLong, ptLeverage, hedge) => capacity(isPaperLong, ptLeverage, hedge),
    exec,
    alert,
    emit,
  });
  
  async function scheduleRound(spec) {
    await (roundsReady ??= rounds.init());
    if (!hl) throw new Error("Set the papertrade and hedge wallets first");
    if (spec.hedge && !(await canTrade())) throw new Error("Set up the trading key (or unlock the main key) to schedule a hedged round");
    if (spec.side !== "long" && spec.side !== "short") throw new Error("Pick long or short");
    if (pageCoin && pageCoin !== settings.coin) throw new Error(`A ${settings.coin} round is running — finish it before trading ${pageCoin}`);
    // must fit both venues now
    const c = capacity(spec.side === "long", spec.ptLeverage, spec.hedge);
    if (!c.ok) throw new Error(c.problems[0]);
    if (spec.marginUsd > c.maxMargin) throw new Error(`Max margin is $${c.maxMargin} — limited by ${c.binding}`);
    if (spec.marginUsd < c.minMargin) throw new Error(`Min margin is $${c.minMargin} at ${spec.ptLeverage}x (papertrade's $${ptLimits.minNotionalUsd.toLocaleString()} minimum notional)`);
    return rounds.schedule({ ...spec, coin: settings.coin });
  }

  async function cancelRound(id) {
    await (roundsReady ??= rounds.init());
    return rounds.cancel(id);
  }

  async function wakeRounds() {
    await (roundsReady ??= rounds.init());
    rounds.wake();
  }

  async function exitRound() {
    await (roundsReady ??= rounds.init());
    const r = rounds.activeRound();
    if (!r) throw new Error("No open trade");
    return rounds.cancel(r.id);
  }

  return { configure, hedgeNow, setAuto, setLeverage, sendToPapertrade, refreshVault, snapshot, emit, scheduleRound, cancelRound, wakeRounds, setupAgent, exitRound, setSessionWallet, setPageCoin, coin: () => settings.coin };
}
