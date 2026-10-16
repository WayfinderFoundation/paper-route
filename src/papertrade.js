// Papertrade account state, read from the same public endpoints papertrade's app uses.
// - /state/user/live?wallet=  SSE `wallet` events carry both full frames and diffs; a diff has
//   `baseAccountRevision` (papertrade's own account-wire.js tells them apart the same way) and must
//   apply to exactly that revision, otherwise the stream is out of sync and has to restart.
// - positions are tuples [positionId, instrumentId, isLong, useDebt, entryPriceRaw,
//   marginRaw, leverage, bustPriceRaw, openedAtMs, intentId]; collateral is 18-decimal.
// - deposits go to a per-owner HyperCore proxy from POST /funding/deposits/check {user}.
// - win fee = exchange.winFeeRate() on HyperEVM (1e18 = 100%).

export const PT_BASE = "https://exchange.papertrade.xyz";
const HYPEREVM_RPC = "https://rpc.hyperliquid.xyz/evm";
const PT_EXCHANGE = "0x6cd5661646289fb6e65ea5c032310fded797d0a2";
const WIN_FEE_RATE_SELECTOR = "0x48ee5e08"; // winFeeRate()
const INSTRUMENTS = { 0: "BTC", 1: "ETH" };
const E18 = 1e18;

const raw = (s) => Number(BigInt(s)) / E18;

function decodePosition(t) {
  const [positionId, instrumentId, isLong, useDebt, entryPriceRaw, marginRaw, leverage, bustPriceRaw, openedAtMs] = t;
  return {
    id: String(positionId),
    coin: INSTRUMENTS[instrumentId],
    isLong,
    useDebt,
    entryRaw: BigInt(entryPriceRaw),
    bustRaw: BigInt(bustPriceRaw),
    margin: raw(marginRaw),
    leverage: Number(leverage),
    openedAtMs,
  };
}

// Price raw scale isn't documented; infer the power of ten that puts the entry next to the
// HL mid (papertrade tracks it to <1 bp) and refuse anything that isn't within 5%.
export function decodePrice(raw, mid) {
  return Number(BigInt(raw)) / priceScale(BigInt(raw), mid);
}

function priceScale(entryRaw, mid) {
  const exp = Math.round(Math.log10(Number(entryRaw) / mid));
  const scale = 10 ** exp;
  const px = Number(entryRaw) / scale;
  if (Math.abs(px / mid - 1) > 0.05) throw new Error(`Can't decode papertrade price ${entryRaw} against mid ${mid}`);
  return scale;
}

// Each open position on `coin`: size in coin units and its liquidation (bust) price.
export function positionsOf(frame, coin, mid) {
  return frame.openPositions
    .map(decodePosition)
    .filter((p) => p.coin === coin)
    .map((p) => {
      const scale = priceScale(p.entryRaw, mid);
      const entry = Number(p.entryRaw) / scale;
      return { id: p.id, coin, isLong: p.isLong, entry, size: (p.margin * p.leverage) / entry, margin: p.margin, leverage: p.leverage, bust: Number(p.bustRaw) / scale, openedAtMs: p.openedAtMs };
    });
}

export function summarize(frame, coin, mid, winFeeRate) {
  const positions = frame.openPositions.map(decodePosition).filter((p) => p.coin === coin);
  let netSize = 0;
  let margin = 0;
  let uPnl = 0;
  let notional = 0;
  let grossSize = 0;
  let bust = null;
  for (const p of positions) {
    const scale = priceScale(p.entryRaw, mid);
    const entry = Number(p.entryRaw) / scale;
    const size = (p.margin * p.leverage) / entry;
    const signed = p.isLong ? size : -size;
    netSize += signed;
    margin += p.margin;
    notional += size * entry;
    grossSize += size;
    uPnl += signed * (mid - entry);
    const pBust = Number(p.bustRaw) / scale;
    bust = bust === null ? pBust : p.isLong ? Math.max(bust, pBust) : Math.min(bust, pBust);
  }
  const uPnlAfterFee = uPnl > 0 ? uPnl * (1 - winFeeRate) : Math.max(uPnl, -margin);
  return {
    positions: positions.length,
    netSize,
    margin,
    notional,
    entry: grossSize ? notional / grossSize : null,
    uPnl,
    uPnlAfterFee,
    bust,
    balance: raw(frame.balance),
    queued: raw(frame.queued),
    available: raw(frame.funds.availableBalance),
    availableQueued: raw(frame.funds.availableQueued),
  };
}

export const isPatch = (payload) => Object.hasOwn(payload, "baseAccountRevision");

export function applyPatch(frame, patch) {
  if (patch.baseAccountRevision !== frame.accountRevision) throw new Error("papertrade account stream out of sync");
  const removedPositions = new Set(patch.removedPositionIds.map(String));
  const removedOps = new Set(patch.removedOperationIds);
  return {
    ...frame,
    ...patch.state,
    accountRevision: patch.accountRevision,
    lifetime: patch.lifetime ?? frame.lifetime,
    openPositions: [...frame.openPositions.filter((t) => !removedPositions.has(String(t[0]))), ...patch.addedPositions],
    operations: [...frame.operations.filter((op) => !removedOps.has(op[0])), ...patch.addedOperations],
  };
}

// SSE over a streamed fetch (EventSource isn't available in service workers). Reconnects with
// backoff until unsubscribed; each reconnect gets a fresh full `wallet` frame first.
// Papertrade sends a liveness event every 10 s, so 25 s of silence means the stream is dead.
const PT_SILENCE_MS = 25_000;

export function subscribeAccount(wallet, { onFrame, onStatus }) {
  const controller = new AbortController();
  let retryMs = 500;
  (async () => {
    while (!controller.signal.aborted) {
      const attempt = new AbortController();
      const onAbort = () => attempt.abort();
      controller.signal.addEventListener("abort", onAbort);
      let watchdog = null;
      try {
        await streamOnce(wallet, attempt, {
          onFrame,
          onStatus,
          onActivity: () => {
            retryMs = 500;
            clearTimeout(watchdog);
            watchdog = setTimeout(() => attempt.abort(), PT_SILENCE_MS);
          },
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        onStatus("down", String(err.message || err));
      } finally {
        clearTimeout(watchdog);
        controller.signal.removeEventListener("abort", onAbort);
      }
      await new Promise((r) => setTimeout(r, retryMs));
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  })();
  return () => controller.abort();
}

async function streamOnce(wallet, controller, { onFrame, onStatus, onActivity }) {
  let frame = null;
  onStatus("connecting");
  const res = await fetch(`${PT_BASE}/state/user/live?wallet=${encodeURIComponent(wallet.toLowerCase())}`, {
    signal: controller.signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!res.ok) throw new Error(`papertrade stream HTTP ${res.status}`);
  onActivity();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onActivity();
    buf += value;
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      const payload = JSON.parse(data.join("\n"));
      if (event !== "wallet") continue;
      if (!isPatch(payload)) {
        frame = payload;
        onStatus("live"); // live only once the full snapshot is in
      } else if (frame) frame = applyPatch(frame, payload); // throws when out of sync -> reconnect for a fresh snapshot
      else continue;
      onFrame(frame);
    }
  }
  throw new Error("papertrade stream ended");
}

// /state/trading: per-instrument tuple [id, symbol, assetIndex, priceScale, active, paused,
// retired, closeOnly, terminal, frozenBid, frozenAsk, pausedAt, rateMultiplier,
// positionMultiplier, maxLeverage, maxPositionNotional, bustBuffer, baseRate,
// referenceNotional, longOi, shortOi, longCap, shortCap] (raw values are 1e18-scaled)
// intake = [revision, minimumPaperStake, maximumNetOpenInterest, pausedActions[]]
const UNLIMITED_CAP = (1n << 128n) - 1n;

// every listed coin's limits from one request
export async function tradingLimitsAll() {
  const res = await fetch(`${PT_BASE}/state/trading`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`papertrade trading state HTTP ${res.status}`);
  const s = await res.json();
  return Object.fromEntries(Object.values(INSTRUMENTS).flatMap((coin) => (s.instruments.some((i) => i[1] === coin) ? [[coin, limitsFrom(s, coin)]] : [])));
}

export async function tradingLimits(coin) {
  const res = await fetch(`${PT_BASE}/state/trading`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`papertrade trading state HTTP ${res.status}`);
  return limitsFrom(await res.json(), coin);
}

function limitsFrom(s, coin) {
  const t = s.instruments.find((i) => i[1] === coin);
  if (!t) throw new Error(`papertrade has no ${coin} market`);
  const [, , , priceScale, active, paused, retired, closeOnly] = t;
  const pausedActions = s.intake?.[3] ?? [];
  return {
    minMarginUsd: raw(s.minimumTradeSizeRaw),
    minNotionalUsd: raw(s.minimumOpenNotionalRaw),
    maxLeverage: Number(t[14]),
    maxPositionNotionalUsd: raw(t[15]),
    bustBuffer: raw(t[16]),
    openable: active && !paused && !retired && !closeOnly && !s.tradingPaused && !pausedActions.includes("openPosition"),
    closable: !s.tradingPaused && !pausedActions.includes("closePositions"),
    // kept raw for sideRoomUsd, which needs the live mark
    oi: { priceScale, longOi: t[19], shortOi: t[20], longCap: t[21], shortCap: t[22], maxNetOi: s.intake?.[2] ?? "0" },
    at: Date.now(),
  };
}

// Notional papertrade will still accept on one side — the same rule as papertrade's ticket:
// the side's cap (unless unlimited), bounded by opposite OI + maximum net OI, minus same-side OI.
export function sideRoomUsd(limits, isLong, mid) {
  const o = limits.oi;
  const ps = BigInt(o.priceScale);
  const mark = BigInt(Math.round(mid * Number(ps)));
  const same = BigInt(isLong ? o.longOi : o.shortOi);
  const opposite = BigInt(isLong ? o.shortOi : o.longOi);
  const cap = BigInt(isLong ? o.longCap : o.shortCap);
  const maxNet = BigInt(o.maxNetOi);
  const netLimit = maxNet > 0n && mark > 0n ? opposite + (maxNet * ps) / mark : null;
  const limit = cap > 0n && cap !== UNLIMITED_CAP && (netLimit === null || cap < netLimit) ? cap : netLimit;
  if (limit === null) return Infinity;
  const room = limit > same ? limit - same : 0n;
  return Number((room * mark) / ps) / E18;
}

export async function winFeeRate() {
  const res = await fetch(HYPEREVM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: PT_EXCHANGE, data: WIN_FEE_RATE_SELECTOR }, "latest"] }),
  });
  const { result } = await res.json();
  return Number(BigInt(result)) / E18;
}

export async function depositProxy(user) {
  const res = await fetch(`${PT_BASE}/funding/deposits/check`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ user: user.toLowerCase() }),
  });
  if (!res.ok) throw new Error(`papertrade deposit check HTTP ${res.status}`);
  return (await res.json()).proxy;
}

// closed trades for these positions, from the account's trade history (newest first; it can take a few
// seconds for a close to appear): { positionId → { paidUsd, paper, liquidated, closedAtMs } }
export async function closedTrades(user, positionIds) {
  const want = new Set(positionIds.map(String));
  const found = {};
  let cursor = null;
  for (let page = 0; page < 5 && Object.keys(found).length < want.size; page++) {
    const res = await fetch(`${PT_BASE}/query/accounts/${user.toLowerCase()}/trades${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!res.ok) throw new Error(`papertrade trade history HTTP ${res.status}`);
    const body = await res.json();
    for (const t of body.items ?? []) {
      if (!want.has(String(t.positionId)) || (t.kind !== "PositionClosed" && t.kind !== "Liquidated")) continue;
      found[t.positionId] = {
        paidUsd: Number(BigInt(t.adjustedPnlRaw ?? "0")) / 1e18,
        paper: Number(BigInt(t.paperMintedRaw ?? "0")) / 1e18,
        liquidated: t.kind === "Liquidated",
        closedAtMs: t.timestampMs,
      };
    }
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return found;
}
