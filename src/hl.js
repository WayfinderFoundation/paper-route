// Hyperliquid reads + order/transfer execution for the hedge wallet.
// Rounding mirrors wayfinder_paths/adapters/hyperliquid_adapter/adapter.py
// (get_valid_order_size / get_valid_order_price / place_market_order).
// Reads retry on transient errors; orders carry a client order id (cloid) so a failed
// attempt can be checked with orderStatus before anything is resent.
import { ExchangeClient, HttpTransport, InfoClient, SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";
import { isTransient, newCloid, sleep, withRetry } from "./retry.js";

// Wayfinder builder fee: f = 20 tenths of a bp = 2 bp of order notional.
export const WAYFINDER_BUILDER = "0xaa1d89f333857ed78f8434cc4f896a9293efe65c";
const BUILDER_FEE_TENTHS_BP = 20;
const BUILDER_MAX_FEE_RATE = "0.02%";
const MIN_ORDER_USD = 10;
const TRIGGER_SLIPPAGE = 0.1; // market TP/SL limit price band, as HL's frontend uses

// ---------- staying inside Hyperliquid's request budget ----------
// Hyperliquid allows 1200 request weight per minute per IP. Paper Route keeps itself to half of
// that, so the Hyperliquid app or other tools on the same connection still fit. Weights from
// Hyperliquid's docs: the cheap info requests cost 2, everything else 20. Shared by every client
// in this worker; a 429 pauses all reads for a while instead of retrying into the limit.
const BUDGET_PER_MIN = 600;
const CHEAP = new Set(["clearinghouseState", "spotClearinghouseState", "allMids", "l2Book", "orderStatus", "exchangeStatus"]);
const COOLDOWN_AFTER_429_MS = 15_000;
const spent = []; // [time, weight]
let cooldownUntil = 0;

async function take(weight) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0][0] > 60_000) spent.shift();
    const used = spent.reduce((a, [, w]) => a + w, 0);
    const wait = Math.max(cooldownUntil - now, used + weight > BUDGET_PER_MIN && spent.length ? spent[0][0] + 60_000 - now : 0);
    if (wait <= 0) {
      spent.push([now, weight]);
      return;
    }
    await sleep(Math.min(wait, 5000));
  }
}

export const budgetUsed = () => spent.filter(([t]) => Date.now() - t <= 60_000).reduce((a, [, w]) => a + w, 0);

// ---------- one shared price feed ----------
// Every watcher (Tether, TP/SL, the safety net) shares one websocket. Prices come from each coin's
// best bid/offer (bbo), which is what papertrade's own price follows; allMids lags it by 3–5 s, so
// it's only used as a heartbeat (bbo pushes only when the top of book changes) and for coins
// nobody is watching.
const mids = { all: {}, bbo: {}, at: 0, listeners: new Map(), sub: null, starting: null, books: new Map() };

function startMids() {
  if (mids.sub || mids.starting) return mids.starting;
  mids.starting = (async () => {
    const ws = new WebSocketTransport();
    const client = new SubscriptionClient({ transport: ws });
    const sub = await client.allMids((e) => {
      mids.at = Date.now();
      for (const [c, v] of Object.entries(e.mids)) mids.all[c] = Number(v);
    });
    mids.sub = { sub, ws, client };
    for (const [coin, fns] of mids.listeners) if (fns.size) watchBook(coin);
  })().finally(() => {
    mids.starting = null;
  });
  return mids.starting;
}

function watchBook(coin) {
  if (!mids.sub || mids.books.has(coin)) return;
  const { client } = mids.sub;
  mids.books.set(coin, null); // subscribing
  client
    .bbo({ coin }, (e) => {
      const [bid, ask] = e.bbo;
      if (!bid || !ask) return;
      const px = (Number(bid.px) + Number(ask.px)) / 2;
      mids.bbo[coin] = px;
      for (const fn of mids.listeners.get(coin) ?? []) fn(px);
    })
    .then(
      (sub) => {
        // the socket may have been replaced, or the coin dropped, while this subscribed
        if (mids.books.get(coin) === null && mids.sub?.client === client) mids.books.set(coin, sub);
        else sub.unsubscribe().catch(() => {});
      },
      () => mids.books.delete(coin),
    );
}

async function unwatchBook(coin) {
  const sub = mids.books.get(coin);
  mids.books.delete(coin);
  delete mids.bbo[coin];
  await sub?.unsubscribe().catch(() => {});
}

async function closeMids() {
  if (!mids.sub) return;
  const { sub, ws } = mids.sub;
  mids.sub = null;
  mids.books.clear();
  mids.bbo = {}; // prices from a dead socket can't be trusted
  await sub.unsubscribe().catch(() => {});
  await ws.close().catch(() => {});
}

const hasListeners = () => [...mids.listeners.values()].some((s) => s.size);

async function stopMidsIfUnused() {
  if (!hasListeners()) await closeMids();
}

// The socket's own reconnect gives up after a few failures (sleep, network blip) and then stays
// silent for good. allMids pushes every second or so; if nothing arrives for a while, start over.
const MIDS_SILENT_MS = 10_000;
setInterval(async () => {
  if (!hasListeners() || mids.starting) return;
  if (mids.sub && Date.now() - mids.at < MIDS_SILENT_MS) return;
  await closeMids();
  mids.at = Date.now(); // give the new socket a full window before judging it
  startMids()?.catch(() => {});
}, 2_000);

// while the socket is alive an unchanged bbo is still the price; without one, the (lagging) allMids
const freshMid = (coin) => {
  if (Date.now() - mids.at >= 5000) return null;
  const px = mids.bbo[coin] ?? mids.all[coin];
  return px > 0 ? px : null;
};

export function createHl() {
  const transport = new HttpTransport({ timeout: 8000 });
  const info = new InfoClient({ transport });
  let perpMeta = null; // coin -> { asset, szDecimals, maxLeverage }
  let usdcToken = null;

  // `kinds`: the info request types this read makes, for the budget
  const read = (label, fn, kinds = [label]) =>
    withRetry(
      async () => {
        await take(kinds.reduce((a, k) => a + (CHEAP.has(k) ? 2 : 20), 0));
        try {
          return await fn();
        } catch (err) {
          if (/429/.test(String(err?.message)) || err?.response?.status === 429) cooldownUntil = Date.now() + COOLDOWN_AFTER_429_MS;
          throw err;
        }
      },
      { label: `Hyperliquid ${label}` },
    );
  const assetData = new Map(); // `${user}:${coin}` → { at, value }: leverage + available-to-trade, the expensive read
  const ASSET_DATA_MS = 15_000;

  async function loadMeta() {
    if (perpMeta) return perpMeta;
    const meta = await read("meta", () => info.meta());
    perpMeta = Object.fromEntries(meta.universe.map((u, i) => [u.name, { asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }]));
    return perpMeta;
  }

  async function usdcTokenName() {
    if (usdcToken) return usdcToken;
    const spot = await read("spotMeta", () => info.spotMeta());
    const t = spot.tokens.find((x) => x.name === "USDC");
    usdcToken = `USDC:${t.tokenId}`;
    return usdcToken;
  }

  async function mid(coin) {
    const cached = freshMid(coin);
    if (cached) return cached;
    const all = await read("allMids", () => info.allMids());
    return Number(all[coin]);
  }

  // The whole account in one read, for every coin Paper Route hedges: shared balances and positions
  // (2 cheap requests), plus per coin the leverage / available-to-trade read (20 each), which is
  // reused for up to 15 s unless that coin is in `fresh` (right before an order on it). Mids come
  // from the shared websocket while it's fresh.
  async function accounts(user, coins, { fresh = [] } = {}) {
    const need = coins.filter((c) => fresh.includes(c) || !assetData.get(`${user}:${c}`) || Date.now() - assetData.get(`${user}:${c}`).at > ASSET_DATA_MS);
    const cachedMids = Object.fromEntries(coins.map((c) => [c, freshMid(c)]));
    const needMids = coins.some((c) => !cachedMids[c]);
    const kinds = ["clearinghouseState", "spotClearinghouseState", ...(needMids ? ["allMids"] : []), ...need.map(() => "activeAssetData")];
    const [perp, spot, allMids, ...actives] = await read(
      "account",
      () =>
        Promise.all([
          info.clearinghouseState({ user }),
          info.spotClearinghouseState({ user }),
          needMids ? info.allMids() : null,
          ...need.map((c) => info.activeAssetData({ user, coin: c })),
        ]),
      kinds,
    );
    need.forEach((c, i) => assetData.set(`${user}:${c}`, { at: Date.now(), value: actives[i] }));
    const midsNow = { ...mids.all, ...(allMids ?? {}), ...Object.fromEntries(Object.entries(cachedMids).filter(([, v]) => v)) };
    const usdc = spot.balances.find((b) => b.coin === "USDC");
    const shared = {
      accountValue: Number(perp.marginSummary.accountValue),
      marginUsed: Number(perp.marginSummary.totalMarginUsed),
      withdrawable: Number(perp.withdrawable),
      spotUsdc: usdc ? Number(usdc.total) - Number(usdc.hold) : 0,
      spotUsdcTotal: usdc ? Number(usdc.total) : 0,
      // the whole account, for the HUD's Hyperliquid section
      positions: perp.assetPositions.map(({ position: p }) => ({
        coin: p.coin,
        size: Number(p.szi),
        entry: Number(p.entryPx),
        mark: Number(midsNow[p.coin]),
        value: Number(p.positionValue),
        uPnl: Number(p.unrealizedPnl),
        roe: Number(p.returnOnEquity),
        liqPx: p.liquidationPx ? Number(p.liquidationPx) : null,
        leverage: { value: p.leverage.value, isCross: p.leverage.type === "cross" },
        margin: Number(p.marginUsed),
        funding: -Number(p.cumFunding.sinceOpen),
      })),
      spot: spot.balances
        .filter((b) => Number(b.total) > 0)
        .map((b) => ({ coin: b.coin, total: Number(b.total), hold: Number(b.hold), usd: b.coin === "USDC" ? Number(b.total) : Number(b.total) * Number(midsNow[b.coin] ?? midsNow[`@${b.token}`] ?? NaN) })),
    };
    const byCoin = Object.fromEntries(
      coins.map((c) => {
        const pos = perp.assetPositions.map((p) => p.position).find((p) => p.coin === c);
        const active = assetData.get(`${user}:${c}`).value;
        return [
          c,
          {
            mid: Number(midsNow[c]),
            size: pos ? Number(pos.szi) : 0,
            entry: pos ? Number(pos.entryPx) : null,
            uPnl: pos ? Number(pos.unrealizedPnl) : 0,
            funding: pos ? -Number(pos.cumFunding.sinceOpen) : 0, // cumFunding is paid; flip so + = received
            liqPx: pos?.liquidationPx ? Number(pos.liquidationPx) : null,
            // the account's leverage setting for this coin, which applies even with no position open
            leverage: { value: active.leverage.value, isCross: active.leverage.type === "cross" },
            // USDC margin free to open a [buy, sell] on this coin (already net of the open position)
            availableToTrade: active.availableToTrade.map(Number),
          },
        ];
      }),
    );
    return { shared, byCoin };
  }

  // one coin, flattened (kept for callers that only care about one)
  async function account(user, coin, { fresh = false } = {}) {
    const { shared, byCoin } = await accounts(user, [coin], { fresh: fresh ? [coin] : [] });
    return { ...shared, ...byCoin[coin] };
  }

  async function openOrders(user, coin) {
    const orders = await read("openOrders", () => info.frontendOpenOrders({ user }));
    return orders.filter((o) => o.coin === coin);
  }

  function exchange(signer) {
    return new ExchangeClient({ transport, wallet: signer });
  }

  async function builderFeeApproved(user) {
    const max = await read("maxBuilderFee", () => info.maxBuilderFee({ user, builder: WAYFINDER_BUILDER }));
    return max >= BUILDER_FEE_TENTHS_BP;
  }

  // user-signed: must be the main wallet, never the agent
  async function approveBuilderFee(mainSigner) {
    await exchange(mainSigner).approveBuilderFee({ maxFeeRate: BUILDER_MAX_FEE_RATE, builder: WAYFINDER_BUILDER });
  }

  // user-signed by the main wallet: lets `agentAddress` trade (not withdraw) for it until validUntil
  async function approveAgent(mainSigner, { agentAddress, name, validUntil }) {
    await exchange(mainSigner).approveAgent({ agentAddress, agentName: `${name} valid_until ${validUntil}` });
  }

  // Sends one order with a cloid. On a transient failure it asks HL whether that cloid
  // exists before resending, so a request that landed but whose response was lost is never
  // doubled. Exchange rejections throw immediately.
  async function placeIdempotent(signer, order, extra, tries = 3) {
    const cloid = newCloid();
    for (let i = 0; i < tries; i++) {
      try {
        const res = await exchange(signer).order({ orders: [{ ...order, c: cloid }], grouping: "na", ...extra });
        return { status: res.response.data.statuses[0], cloid };
      } catch (err) {
        if (!isTransient(err)) throw err;
        await sleep(400 * 2 ** i);
        // an agent signs for the hedge wallet, so order state lives under signer.user
        const st = await read("orderStatus", () => info.orderStatus({ user: signer.user ?? signer.address, oid: cloid }));
        if (st.status === "order") return { status: fromOrderStatus(st.order), cloid };
        if (i === tries - 1) throw new Error(`Order not confirmed after ${tries} attempts: ${err.message}`, { cause: err });
      }
    }
  }

  function fromOrderStatus(o) {
    if (o.status === "filled") {
      return { filled: { totalSz: o.order.origSz, avgPx: o.order.limitPx, oid: o.order.oid } };
    }
    if (o.status === "open" || o.status === "triggered") return { resting: { oid: o.order.oid } };
    return { error: `order ${o.status}` };
  }

  // IOC at mid ± slippage. Returns the confirmed fill; throws on anything that isn't a fill.
  async function marketOrder(signer, { coin, isBuy, size, reduceOnly, slippageBps, builderFee }) {
    const meta = (await loadMeta())[coin];
    const m = await mid(coin);
    const sz = roundSize(Math.abs(size), meta.szDecimals);
    if (sz <= 0) throw new Error("Size rounds to zero");
    if (sz * m < MIN_ORDER_USD) throw new Error(`Order $${(sz * m).toFixed(2)} is under the $${MIN_ORDER_USD} minimum`);
    const px = roundPrice(m * (1 + ((isBuy ? 1 : -1) * slippageBps) / 1e4), meta.szDecimals);
    const { status } = await placeIdempotent(
      signer,
      { a: meta.asset, b: isBuy, p: px, s: String(sz), r: reduceOnly, t: { limit: { tif: "Ioc" } } },
      builderFee ? { builder: { b: WAYFINDER_BUILDER, f: BUILDER_FEE_TENTHS_BP } } : {},
    );
    if (!status.filled) throw new Error(`Order not filled: ${JSON.stringify(status)}`);
    return { size: Number(status.filled.totalSz), avgPx: Number(status.filled.avgPx), oid: status.filled.oid, isBuy };
  }

  // A reduce-only market trigger order resting on the exchange: it closes `size` of the HL leg at
  // `triggerPx` even if this browser is gone.
  async function placeTrigger(signer, { coin, closeIsBuy, size, triggerPx, tpsl }) {
    const meta = (await loadMeta())[coin];
    const order = {
      a: meta.asset,
      b: closeIsBuy,
      p: roundPrice(triggerPx * (1 + (closeIsBuy ? 1 : -1) * TRIGGER_SLIPPAGE), meta.szDecimals),
      s: String(roundSize(Math.abs(size), meta.szDecimals)),
      r: true,
      t: { trigger: { isMarket: true, triggerPx: roundPrice(triggerPx, meta.szDecimals), tpsl } },
    };
    const { status } = await placeIdempotent(signer, order, {});
    const oid = status.resting?.oid ?? status.filled?.oid;
    if (oid === undefined) throw new Error(`${tpsl.toUpperCase()} not placed: ${JSON.stringify(status)}`);
    return oid;
  }

  async function placeBrackets(signer, { coin, closeIsBuy, size, tpPx, slPx }) {
    const tpOid = await placeTrigger(signer, { coin, closeIsBuy, size, triggerPx: tpPx, tpsl: "tp" });
    const slOid = await placeTrigger(signer, { coin, closeIsBuy, size, triggerPx: slPx, tpsl: "sl" });
    return { tpOid, slOid };
  }

  async function cancel(signer, coin, oids) {
    if (!oids.length) return;
    const meta = (await loadMeta())[coin];
    try {
      await exchange(signer).cancel({ cancels: oids.map((o) => ({ a: meta.asset, o })) });
    } catch (err) {
      // already filled/cancelled is the outcome we wanted
      if (!/already canceled|never placed|or was filled/i.test(String(err.message))) throw err;
    }
  }

  async function setLeverage(signer, coin, leverage, isCross) {
    const meta = (await loadMeta())[coin];
    if (leverage > meta.maxLeverage) throw new Error(`${coin} max leverage on Hyperliquid is ${meta.maxLeverage}x`);
    await withRetry(() => exchange(signer).updateLeverage({ asset: meta.asset, isCross, leverage }), { label: "updateLeverage" });
  }

  async function perpToSpot(signer, amount) {
    await exchange(signer).usdClassTransfer({ amount: amount.toFixed(2), toPerp: false });
  }

  async function sendUsdc(signer, destination, amount) {
    await exchange(signer).sendAsset({
      destination,
      sourceDex: "spot",
      destinationDex: "spot",
      token: await usdcTokenName(),
      amount: amount.toFixed(2),
    });
  }

  // 1-minute high/low between two times (for levels crossed while nothing was watching)
  async function priceRange(coin, startTime, endTime) {
    const candles = await read("candleSnapshot", () => info.candleSnapshot({ coin, interval: "1m", startTime, endTime }));
    if (!candles.length) return null;
    return { high: Math.max(...candles.map((c) => Number(c.h))), low: Math.min(...candles.map((c) => Number(c.l))) };
  }

  async function abstraction(user) {
    return read("userAbstraction", () => info.userAbstraction({ user }));
  }

  // Low-latency mids over HL's websocket (auto-reconnects and re-subscribes).
  // listens on the shared price feed; the returned function stops listening
  async function subscribeMid(coin, onMid) {
    if (!mids.listeners.has(coin)) mids.listeners.set(coin, new Set());
    mids.listeners.get(coin).add(onMid);
    await startMids();
    watchBook(coin);
    return async () => {
      const fns = mids.listeners.get(coin);
      fns?.delete(onMid);
      if (!fns?.size) await unwatchBook(coin);
      await stopMidsIfUnused();
    };
  }

  return { loadMeta, mid, account, accounts, openOrders, marketOrder, placeTrigger, placeBrackets, cancel, setLeverage, perpToSpot, sendUsdc, abstraction, priceRange, subscribeMid, builderFeeApproved, approveBuilderFee, approveAgent };
}

export function roundSize(size, szDecimals) {
  const f = 10 ** szDecimals;
  return Math.floor(size * f + 1e-9) / f;
}

// 5 significant figures, at most (6 - szDecimals) decimals for perps.
export function roundPrice(px, szDecimals) {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Number(px.toPrecision(5));
  return String(Number(sig.toFixed(maxDecimals)));
}
