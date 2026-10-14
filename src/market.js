// Hyperliquid public market data for the HUD: one websocket in the service worker, subscribed to
// l2Book / trades / activeAssetCtx for every coin an open papertrade tab is showing. Each tab gets
// a frame per 100 ms tick with the mid, the flow features and the index.
// An open socket with traffic keeps the MV3 worker alive while a papertrade tab is open.
import { TICK_MS, createFlowEngine, regimeOf, rowFromBook, scoreIndex } from "./flowindex.js";
import WEIGHTS from "./index-weights.json";

const WS_URL = "wss://api.hyperliquid.xyz/ws"; // papertrade tracks mainnet prices, whatever the hedge network
const PING_MS = 30_000;

const ports = new Map(); // port -> coin
const coins = new Map(); // coin -> { engine, book, trades, assetCtx, timer }
let ws = null;
let wsState = "idle";
let retryMs = 500;
let retryTimer = null;
let pingTimer = null;

const SUBS = (coin) => [
  { type: "l2Book", coin },
  { type: "bbo", coin }, // top of book updates faster than l2Book; the index was fitted on it
  { type: "trades", coin },
  { type: "activeAssetCtx", coin },
];

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function subscribe(coin) {
  for (const subscription of SUBS(coin)) send({ method: "subscribe", subscription });
}

function connect() {
  if (ws || coins.size === 0) return;
  wsState = "connecting";
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    wsState = "live";
    retryMs = 500;
    for (const coin of coins.keys()) subscribe(coin);
    pingTimer = setInterval(() => send({ method: "ping" }), PING_MS);
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    clearInterval(pingTimer);
    ws = null;
    wsState = "down";
    if (coins.size === 0) return;
    retryTimer ??= setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 10_000);
  };
  ws.onerror = () => {}; // onclose follows
}

function onMessage(msg) {
  const { channel, data } = msg;
  if (channel === "l2Book") {
    const c = coins.get(data.coin);
    if (!c) return;
    const [bids, asks] = data.levels;
    if (!bids.length || !asks.length) return;
    c.l2 = {
      bids: bids.slice(0, 10).map((l) => [Number(l.px), Number(l.sz)]),
      asks: asks.slice(0, 10).map((l) => [Number(l.px), Number(l.sz)]),
    };
    c.book = { bids: c.l2.bids, asks: c.l2.asks };
    c.seen = true;
  } else if (channel === "bbo") {
    const c = coins.get(data.coin);
    const [bid, ask] = data.bbo;
    if (!c?.l2 || !bid || !ask) return;
    // level 1 from bbo (several updates a second; l2Book only every few seconds); deeper levels from the
    // last l2Book, keeping those strictly behind the new best (as the index's training data was built)
    const b1 = Number(bid.px);
    const a1 = Number(ask.px);
    c.book = {
      bids: [[b1, Number(bid.sz)], ...c.l2.bids.slice(1).filter((l) => l[0] < b1)],
      asks: [[a1, Number(ask.sz)], ...c.l2.asks.slice(1).filter((l) => l[0] > a1)],
    };
    c.seen = true;
  } else if (channel === "trades") {
    for (const t of data) {
      const c = coins.get(t.coin);
      if (!c) continue;
      c.trades.push({ isBuy: t.side === "B", sz: Number(t.sz) });
      c.seen = true;
    }
  } else if (channel === "activeAssetCtx") {
    const c = coins.get(data.coin);
    if (!c) return;
    const x = data.ctx;
    c.assetCtx = { markPx: Number(x.markPx), oraclePx: Number(x.oraclePx), funding: Number(x.funding), openInterest: Number(x.openInterest) };
    c.seen = true;
  }
}

// One 100 ms bucket: the latest book (forward-filled when it hasn't changed) and the trades
// received since the previous tick, the same bucketing the index was fitted on. A tick is
// "observed" when any channel sent something since the last one (the gap rule counts silence).
function tick(coin) {
  const c = coins.get(coin);
  const trades = c.trades;
  c.trades = [];
  const now = Date.now();
  const w = WEIGHTS[coin] ?? null;
  const frame = { kind: "market", coin, ts: now, feed: wsState, stale: true };
  if (c.book) {
    const observed = c.seen;
    c.seen = false;
    const row = rowFromBook({ ts: now, book: c.book, trades, ctx: c.assetCtx });
    const out = c.engine.step(row, observed);
    if (out) {
      Object.assign(frame, {
        stale: false,
        mid: row.mid,
        bid: row.bid_px,
        ask: row.ask_px,
        x: out.x,
        warm: out.warm,
        warmLeftS: out.warmLeftS,
        regime: regimeOf(out.x.vol_600s, w),
        index: w ? scoreIndex(out.x, w) : null,
        hasModel: !!w,
        provisional: !!w?.provisional,
      });
    }
  }
  for (const [port, pc] of ports) if (pc === coin) port.postMessage(frame);
}

function watch(coin) {
  if (coins.has(coin)) return;
  coins.set(coin, { engine: createFlowEngine(), book: null, l2: null, seen: false, trades: [], assetCtx: null, timer: setInterval(() => tick(coin), TICK_MS) });
  if (ws) subscribe(coin);
  else connect();
}

// A coin nobody is viewing keeps its windows for a while, so reloading papertrade or flipping
// BTC ↔ ETH doesn't restart the 10-minute warm-up.
const KEEP_UNWATCHED_MS = 120_000;
let sweepTimer = null;

function unwatchUnused() {
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(sweep, KEEP_UNWATCHED_MS);
}

function sweep() {
  const used = new Set(ports.values());
  for (const [coin, c] of coins) {
    if (used.has(coin)) continue;
    clearInterval(c.timer);
    coins.delete(coin);
    for (const subscription of SUBS(coin)) send({ method: "unsubscribe", subscription });
  }
  if (coins.size === 0) {
    clearTimeout(retryTimer);
    retryTimer = null;
    ws?.close();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "wf-pr-market") return;
  port.onMessage.addListener(({ coin }) => {
    const c = String(coin ?? "").toUpperCase();
    if (!(c in WEIGHTS)) return;
    ports.set(port, c);
    watch(c);
    unwatchUnused();
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    unwatchUnused();
  });
});

export const indexWeights = (coin) => WEIGHTS[coin] ?? null;
