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

export function createHl({ testnet }) {
  const transport = new HttpTransport({ isTestnet: testnet, timeout: 8000 });
  const info = new InfoClient({ transport });
  let perpMeta = null; // coin -> { asset, szDecimals, maxLeverage }
  let usdcToken = null;

  const read = (label, fn) => withRetry(fn, { label: `Hyperliquid ${label}` });

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
    const mids = await read("allMids", () => info.allMids());
    return Number(mids[coin]);
  }

  async function account(user, coin) {
    const [perp, spot, mids, active] = await read("account", () =>
      Promise.all([
        info.clearinghouseState({ user }),
        info.spotClearinghouseState({ user }),
        info.allMids(),
        info.activeAssetData({ user, coin }),
      ]),
    );
    const pos = perp.assetPositions.map((p) => p.position).find((p) => p.coin === coin);
    const usdc = spot.balances.find((b) => b.coin === "USDC");
    return {
      mid: Number(mids[coin]),
      size: pos ? Number(pos.szi) : 0,
      entry: pos ? Number(pos.entryPx) : null,
      uPnl: pos ? Number(pos.unrealizedPnl) : 0,
      funding: pos ? -Number(pos.cumFunding.sinceOpen) : 0, // cumFunding is paid; flip so + = received
      liqPx: pos?.liquidationPx ? Number(pos.liquidationPx) : null,
      // the account's leverage setting for this coin, which applies even with no position open
      leverage: { value: active.leverage.value, isCross: active.leverage.type === "cross" },
      // USDC margin free to open a [buy, sell] on this coin (already net of the open position)
      availableToTrade: active.availableToTrade.map(Number),
      accountValue: Number(perp.marginSummary.accountValue),
      marginUsed: Number(perp.marginSummary.totalMarginUsed),
      withdrawable: Number(perp.withdrawable),
      spotUsdc: usdc ? Number(usdc.total) - Number(usdc.hold) : 0,
    };
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
  async function subscribeMid(coin, onMid) {
    const ws = new WebSocketTransport({ isTestnet: testnet });
    const sub = await new SubscriptionClient({ transport: ws }).allMids((e) => {
      const v = Number(e.mids[coin]);
      if (v > 0) onMid(v);
    });
    return async () => {
      await sub.unsubscribe().catch(() => {});
      await ws.close().catch(() => {});
    };
  }

  return { loadMeta, mid, account, openOrders, marketOrder, placeTrigger, placeBrackets, cancel, setLeverage, perpToSpot, sendUsdc, abstraction, priceRange, subscribeMid, builderFeeApproved, approveBuilderFee, approveAgent };
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
