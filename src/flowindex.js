// Order-flow features from Hyperliquid's public websocket, on a 100 ms grid, and the linear
// index fitted on them. Pure (no I/O): the browser feed and the parity fixture (recorded rows with
// the values the fit computed) go through the same step().
//
// A row is one 100 ms bucket on the receive clock:
//   { ts, mid, bid_px, ask_px, bid_sz, ask_sz,          L1
//     imb1, imb10, depth_bid_5, depth_ask_5,            book aggregates (rowFromBook builds these)
//     mark, oracle, funding, oi,                        activeAssetCtx (forward-filled)
//     buy_sz, sell_sz, trade_count }                    taker trades received in (ts − 100 ms, ts]
//
// Features (rows: 1 s = 10). Rolling windows need a FULL window since the segment started; until
// then the feature is undefined (NaN) and the index treats it as its training mean.
//   micro_bps        ln(micro / mid)·1e4, micro = (ask·bidSz + bid·askSz) / (bidSz + askSz)
//   imb1/imb5/imb10  (Σbid − Σask) / (Σbid + Σask) over the top 1 / 5 / 10 levels
//   ofi_Ws           Σ Cont–Kukanov–Stoikov L1 OFI over W, / 60 s mean of (bidSz1 + askSz1)
//   flow_Ws          Σ(buy − sell size) over W;  flowz_Ws = flow_Ws / (600 s mean of |flow_Ws| + 1e-9)
//   ret_Ws           (ln mid_t − ln mid_{t−W})·1e4
//   vol_Ws           sample std (ddof 1) of overlapping 1 s returns over W
//   oi_signed_300s   Δln(OI)·1e4 over 300 s × sign(ret_300s)
//   mark_mid_bps / oracle_mid_bps   ln(mark | oracle / mid)·1e4;  funding_bps = funding·1e4
//   burst_ratio      EWM(trades, half-life 5 rows) / (EWM(trades, half-life 300 rows) + 1e-3)
//   ofiq_Ws          Σ OFI over W / 10 s mean of (bidSz1 + askSz1)  (short warm-up OFI)
//   imb1_chg_2s      imb1_t − imb1_{t−2 s}
//   l1_rel_imb       ln(bidSz1 / 60 s mean bidSz1) − ln(askSz1 / 60 s mean askSz1)
//   l1dq_2s          [(bidSz1 − bidSz1_{t−2s})·1{bid1 unchanged} − (askSz1 − askSz1_{t−2s})·1{ask1 unchanged}]
//                    / 60 s mean of (bidSz1 + askSz1)
// A segment ends after more than 10 s with no message on any channel (book, bbo, trades, asset
// context): every window restarts from empty. Shorter stalls are forward-filled.

export const TICK_MS = 100;
export const GAP_MS = 10_000;
const R = (s) => Math.round((s * 1000) / TICK_MS);

// rolling sum/mean/std over the last n values; NaN until n values have been pushed
class Window {
  constructor(n) {
    this.n = n;
    this.buf = new Float64Array(n);
    this.i = 0;
    this.count = 0;
    this.sum = 0;
    this.sumSq = 0;
  }
  push(v) {
    if (this.count === this.n) {
      const old = this.buf[this.i];
      this.sum -= old;
      this.sumSq -= old * old;
    } else {
      this.count += 1;
    }
    this.buf[this.i] = v;
    this.sum += v;
    this.sumSq += v * v;
    this.i = (this.i + 1) % this.n;
  }
  get full() {
    return this.count === this.n;
  }
  total() {
    return this.full ? this.sum : NaN;
  }
  mean() {
    return this.full ? this.sum / this.n : NaN;
  }
  std() {
    if (!this.full) return NaN;
    const m = this.sum / this.n;
    return Math.sqrt(Math.max(0, (this.sumSq - this.n * m * m) / (this.n - 1)));
  }
}

// the value `lag` rows ago, or NaN before the segment reached back that far
class Lag {
  constructor(maxLag) {
    this.n = maxLag + 1;
    this.buf = new Float64Array(this.n);
    this.i = 0;
    this.count = 0;
  }
  push(v) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.n;
    this.count = Math.min(this.count + 1, this.n);
  }
  ago(lag) {
    return lag < this.count ? this.buf[(this.i - 1 - lag + 2 * this.n) % this.n] : NaN;
  }
}

// adjusted EWM (adjust=True): num/den, alpha = 1 − exp(−ln2 / halfLife)
class Ewm {
  constructor(halfLife) {
    this.keep = Math.exp(-Math.LN2 / halfLife);
    this.num = 0;
    this.den = 0;
  }
  push(v) {
    this.num = v + this.keep * this.num;
    this.den = 1 + this.keep * this.den;
    return this.num / this.den;
  }
}

// rolling windows Σx over W whose |·| is averaged again over 600 s (flowz)
class ZWindow {
  constructor(rows) {
    this.sum = new Window(rows);
    this.abs = new Window(R(600));
  }
  push(v) {
    this.sum.push(v);
    const f = this.sum.total();
    if (Number.isFinite(f)) this.abs.push(Math.abs(f));
    return { flow: f, z: f / (this.abs.mean() + 1e-9) };
  }
}

const OFI_W = [1, 5, 30];
const FLOW_W = [5, 30];
const VOL_W = [60, 600];

export function createFlowEngine() {
  let s;
  let lastObservedTs = null;

  function reset() {
    s = {
      lnMid: new Lag(R(300)),
      lnOi: new Lag(R(300)),
      r1: Object.fromEntries(VOL_W.map((w) => [w, new Window(R(w))])),
      depth: new Window(R(60)),
      depthQuick: new Window(R(10)),
      bidSz: new Window(R(60)),
      askSz: new Window(R(60)),
      lagL1: { bid: new Lag(R(2)), bidSz: new Lag(R(2)), ask: new Lag(R(2)), askSz: new Lag(R(2)), imb1: new Lag(R(2)) },
      ofi: Object.fromEntries(OFI_W.map((w) => [w, new Window(R(w))])),
      flow: Object.fromEntries(FLOW_W.map((w) => [w, new ZWindow(R(w))])),
      burstFast: new Ewm(5),
      burstSlow: new Ewm(300),
      prev: null,
      rows: 0,
    };
  }
  reset();

  // `observed` is false for a forward-filled bucket (no message on any channel since the last tick)
  function step(row, observed = true) {
    if (observed) {
      if (lastObservedTs !== null && row.ts - lastObservedTs > GAP_MS) reset();
      lastObservedTs = row.ts;
    } else if (lastObservedTs === null || row.ts - lastObservedTs > GAP_MS) {
      return null; // in a gap: no features until the book comes back
    }

    s.rows += 1;
    const { mid, bid_px: bid, ask_px: ask, bid_sz: bidSz, ask_sz: askSz } = row;
    const lnMid = Math.log(mid);
    s.lnMid.push(lnMid);
    const ret = (w) => (lnMid - s.lnMid.ago(R(w))) * 1e4;
    const r1 = ret(1);
    if (Number.isFinite(r1)) for (const w of VOL_W) s.r1[w].push(r1);

    let e = 0;
    const p = s.prev;
    if (p) {
      const eBid = bid > p.bid ? bidSz : bid < p.bid ? -p.bidSz : bidSz - p.bidSz;
      const eAsk = ask < p.ask ? askSz : ask > p.ask ? -p.askSz : askSz - p.askSz;
      e = eBid - eAsk;
    }
    s.prev = { bid, bidSz, ask, askSz };
    s.depth.push(bidSz + askSz);
    s.depthQuick.push(bidSz + askSz);
    s.bidSz.push(bidSz);
    s.askSz.push(askSz);
    for (const w of OFI_W) s.ofi[w].push(e);
    const depth = s.depth.mean();
    const depthQuick = s.depthQuick.mean();
    const lag = s.lagL1;
    const imb1 = (bidSz - askSz) / (bidSz + askSz);
    for (const [k, v] of [["bid", bid], ["bidSz", bidSz], ["ask", ask], ["askSz", askSz], ["imb1", imb1]]) lag[k].push(v);
    const L2 = R(2);
    const dBid = (bidSz - lag.bidSz.ago(L2)) * (bid === lag.bid.ago(L2) ? 1 : 0);
    const dAsk = (askSz - lag.askSz.ago(L2)) * (ask === lag.ask.ago(L2) ? 1 : 0);

    const net = row.buy_sz - row.sell_sz;
    const flows = Object.fromEntries(FLOW_W.map((w) => [w, s.flow[w].push(net)]));
    const burst = s.burstFast.push(row.trade_count) / (s.burstSlow.push(row.trade_count) + 1e-3);

    let oiSigned = NaN;
    if (row.oi > 0) {
      const lnOi = Math.log(row.oi);
      s.lnOi.push(lnOi);
      oiSigned = (lnOi - s.lnOi.ago(R(300))) * 1e4 * Math.sign(ret(300));
    }

    const micro = (ask * bidSz + bid * askSz) / (bidSz + askSz);
    const d5 = row.depth_bid_5 + row.depth_ask_5;
    const x = {
      micro_bps: Math.log(micro / mid) * 1e4,
      imb1,
      imb5: d5 > 0 ? (row.depth_bid_5 - row.depth_ask_5) / d5 : NaN,
      imb10: row.imb10,
      ofi_1s: s.ofi[1].total() / depth,
      ofi_5s: s.ofi[5].total() / depth,
      ofi_30s: s.ofi[30].total() / depth,
      ofiq_1s: s.ofi[1].total() / depthQuick,
      ofiq_5s: s.ofi[5].total() / depthQuick,
      imb1_chg_2s: imb1 - lag.imb1.ago(L2),
      l1_rel_imb: Math.log(bidSz / s.bidSz.mean()) - Math.log(askSz / s.askSz.mean()),
      l1dq_2s: (dBid - dAsk) / depth,
      flow_5s: flows[5].flow,
      flow_30s: flows[30].flow,
      flowz_5s: flows[5].z,
      flowz_30s: flows[30].z,
      ret_5s: ret(5),
      ret_30s: ret(30),
      ret_300s: ret(300),
      oi_signed_300s: oiSigned,
      mark_mid_bps: row.mark > 0 ? Math.log(row.mark / mid) * 1e4 : NaN,
      oracle_mid_bps: row.oracle > 0 ? Math.log(row.oracle / mid) * 1e4 : NaN,
      funding_bps: Number.isFinite(row.funding) ? row.funding * 1e4 : NaN,
      vol_60s: s.r1[60].std(),
      vol_600s: s.r1[600].std(),
      burst_ratio: burst,
    };
    // forecasts start with the quick model (10 s of history) and switch to the full one at 60 s;
    // only the regime label waits for 10 minutes of returns
    const regimeLeftS = Number.isFinite(x.vol_600s) ? 0 : Math.max(0, (R(600) + R(1) - s.rows) * (TICK_MS / 1000));
    return { x, warm: regimeLeftS === 0, warmLeftS: regimeLeftS, rows: s.rows };
  }

  return { step, reset };
}

// The browser side of a row: L1 and depth aggregates from an l2Book snapshot (best level first).
export function rowFromBook({ ts, book, trades, ctx }) {
  const [bid, bidSz] = book.bids[0];
  const [ask, askSz] = book.asks[0];
  const sum = (levels, k) => levels.slice(0, k).reduce((a, l) => a + l[1], 0);
  const b10 = sum(book.bids, 10);
  const a10 = sum(book.asks, 10);
  let buy = 0;
  let sell = 0;
  for (const t of trades) {
    if (t.isBuy) buy += t.sz;
    else sell += t.sz;
  }
  return {
    ts,
    mid: (bid + ask) / 2,
    bid_px: bid,
    ask_px: ask,
    bid_sz: bidSz,
    ask_sz: askSz,
    imb1: (bidSz - askSz) / (bidSz + askSz),
    imb10: (b10 - a10) / (b10 + a10),
    depth_bid_5: sum(book.bids, 5),
    depth_ask_5: sum(book.asks, 5),
    mark: ctx?.markPx ?? NaN,
    oracle: ctx?.oraclePx ?? NaN,
    funding: ctx?.funding ?? NaN,
    oi: ctx?.openInterest ?? NaN,
    buy_sz: buy,
    sell_sz: sell,
    trade_count: trades.length,
  };
}

// weights (src/index-weights.json, per coin):
//   { models: { quick, full }, regimes: { vol600: [calm, normal] }, provisional? }
//   model = { features, mean, std, history_s, horizons: { "10": { coef, intercept, scale, ic, show } } }
// pred_bp = intercept + Σ coef·(x − mean)/std;  index = clip(50·pred/scale, −100, 100)
// The full model is used once all its features exist (60 s after a segment starts), the quick one
// before that (10 s); nothing before the quick one is ready.
export function scoreIndex(x, weights) {
  const ready = (m) => m && m.features.every((f) => Number.isFinite(x[f]));
  const tier = ready(weights.models.full) ? "full" : ready(weights.models.quick) ? "quick" : null;
  if (!tier) return null;
  const m = weights.models[tier];
  const z = m.features.map((f, i) => (x[f] - m.mean[i]) / m.std[i]);
  const horizons = Object.entries(m.horizons).map(([s, h]) => {
    const terms = z.map((zi, i) => zi * h.coef[i]);
    const bps = h.intercept + terms.reduce((a, b) => a + b, 0);
    return { s: Number(s), ret_bps: bps, score: Math.max(-100, Math.min(100, (50 * bps) / h.scale)), terms, show: h.show !== false, ic: h.ic ?? null };
  });
  const lead = horizons.find((h) => h.show) ?? horizons[0];
  const components = m.features.map((f, i) => ({ name: f, value: x[f], z: z[i], contrib: lead.terms[i] }));
  return { horizons, score: lead.score, lead: lead.s, components, model: tier, provisional: !!weights.provisional };
}

export function regimeOf(vol600, weights) {
  const cuts = weights?.regimes?.vol600;
  if (!cuts || !Number.isFinite(vol600)) return null;
  return vol600 < cuts[0] ? "calm" : vol600 < cuts[1] ? "normal" : "wild";
}
