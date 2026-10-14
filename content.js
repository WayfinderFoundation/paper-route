// Isolated-world overlay: Paper Route HUD panel + a layer over papertrade's chart.
// Market frames (Hyperliquid mid, order-flow features, index) arrive from the service worker over
// a port every 100 ms; rendering is coalesced to one rAF.
(() => {
  if (window.__wfPapertradeOverlay) return;
  window.__wfPapertradeOverlay = true;

  const STALE_MS = 2000;
  const TOP_PILL_Y = 50; // below papertrade's ticker/OI bar that sits inside the chart box
  const LEAN_AT = 40; // |index| from which the projection takes a colour instead of grey
  const MARK_PATH =
    "M15.9,0C7.1,0,0,7.2,0,16s7.1,16,15.9,16,15.9-7.2,15.9-16S24.6,0,15.9,0ZM15.9,3.4c6.5,0,11.8,4.9,12.4,11.2h-5.7c0,0-.2,0-.2,0l-4-4c0,0-.1,0-.2,0h-4.7c0,0-.1,0-.2,0l-4,4c0,0-.1,0-.2,0H3.4c.7-6.3,6-11.2,12.4-11.2ZM15.9,28.6c-2.4,0-4.6-.7-6.5-1.8l2.4-2.4c0,0,.1,0,.2,0h7.9c0,0,.1,0,.2,0l2.4,2.4c-1.9,1.2-4.1,1.8-6.5,1.8ZM25.3,24.3h-4.8c0,0-.1,0-.2,0l-2.6-2.6c0,0-.1,0-.2,0h-3.1c0,0-.1,0-.2,0l-2.6,2.6c0,0-.1,0-.2,0h-4.8c-.1-.1-.2-.3-.3-.4l3.6-3.7c0,0,.1,0,.2,0h11.8c0,0,.1,0,.2,0l3.7,3.7c-.1.1-.2.3-.3.4ZM27.7,20.1h-5.1c0,0-.1,0-.2,0l-4-4c0,0-.1,0-.2,0h-4.7c0,0-.1,0-.2,0l-4,4c0,0-.1,0-.2,0h-5.1c-.2-.4-.3-.9-.4-1.3h1.9c0,0,.1,0,.2,0l4-4c0,0,.1,0,.2,0h11.8c0,0,.1,0,.2,0l4,4c0,0,.1,0,.2,0h1.9c-.1.5-.2.9-.4,1.3Z";
  const ICON_CHART =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12l3.5-4 3 2.5L14 4"/><path d="M10.5 4H14v3.5"/></svg>';
  const ICON_CHEVRON =
    '<svg class="sec-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
  const ICON_COLLAPSE =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h8"/></svg>';

  // Canvas palette: same tokens as hud.css. Canvas accepts oklch().
  const tone = {
    up: (a = 1) => `oklch(0.71 0.194 150 / ${a})`,
    down: (a = 1) => `oklch(0.65 0.2 25 / ${a})`,
    amber: (a = 1) => `oklch(0.8 0.15 75 / ${a})`,
    ink: (a = 1) => `oklch(0.16 0.004 270 / ${a})`,
    fg: (a = 1) => `oklch(0.96 0.003 262 / ${a})`,
    muted: (a = 1) => `oklch(0.7 0.01 262 / ${a})`,
    idle: (a = 1) => `oklch(0.6 0.008 262 / ${a})`,
  };
  const HEADING_FONT = `"GeneralSans", ui-sans-serif, system-ui, sans-serif`;

  const fontFace = new FontFace("GeneralSans", `url(${chrome.runtime.getURL("assets/GeneralSans-Variable.woff2")})`, { weight: "200 700" });
  fontFace.load().then((f) => {
    document.fonts.add(f);
    schedule();
  });

  // Components shown under the gauge, grouped the way a trader reads them. `keys` are feature
  // names from src/flowindex.js; the row shows the first one the index uses (or the first key).
  const COMPONENTS = [
    { label: "Microprice", keys: ["micro_bps"], unit: "bp", hint: "Size-weighted top of book vs mid" },
    { label: "Book imbalance", keys: ["imb5", "imb10", "imb1"], unit: "", hint: "(bids − asks) / (bids + asks), top levels" },
    { label: "Order-flow imbalance", keys: ["ofi_5s", "ofi_1s", "ofi_30s"], unit: "", hint: "Cont–Kukanov–Stoikov OFI over the window, per unit of top-of-book depth" },
    { label: "Taker flow", keys: ["flowz_5s", "flowz_30s"], unit: "z", hint: "Aggressive buys − sells over the window, vs its own 10-minute typical size" },
    { label: "Momentum", keys: ["ret_5s", "ret_30s", "ret_300s"], unit: "bp", hint: "Mid change over the window" },
    { label: "Open interest", keys: ["oi_signed_300s"], unit: "bp", hint: "5-minute OI change, signed by the price move" },
    { label: "Mark − mid", keys: ["mark_mid_bps", "oracle_mid_bps"], unit: "bp", hint: "Hyperliquid mark price vs the book mid" },
    { label: "Funding", keys: ["funding_bps"], unit: "bp/h", hint: "Current hourly funding rate" },
  ];
  const WINDOW_OF = (k) => k.match(/_(\d+s)$/)?.[1] ?? (k.match(/imb(\d+)/) ? `top ${k.match(/imb(\d+)/)[1]}` : "");

  // ---------- state ----------
  const state = {
    coin: null,
    frame: null,
    recvMs: 0,
    tickTimes: [],
    map: null,
    dirty: false,
    overlayEnabled: true,
    levels: [], // round / position levels from hedge-ui
  };

  // ---------- formatting ----------
  const fmtPx = (p) => p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPxShort = (p) => p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtBps = (b) => `${b >= 0 ? "+" : "−"}${Math.abs(b).toFixed(2)}`;
  const fmtPct = (p) => `${Math.round(p * 100)}%`;
  const fmtVal = (v, unit) => {
    if (!Number.isFinite(v)) return "—";
    const d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
    return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}${unit ? ` ${unit}` : ""}`;
  };

  // ---------- DOM ----------
  const host = document.createElement("div");
  host.id = "paper-route-overlay";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  fetch(chrome.runtime.getURL("hud.css")).then((r) => r.text()).then((css) => (style.textContent = css));

  const overlay = document.createElement("canvas");
  overlay.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483645;";

  // static markup only; all live values are written with textContent
  const hud = document.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `
    <div class="head">
      <div class="head-l">
        <span class="logo-tile"><svg class="logo" viewBox="0 0 31.7 32"><path fill="#8B2020" d="${MARK_PATH}"/></svg></span>
        <span class="cap">Paper Route HUD</span>
      </div>
      <svg class="grip" viewBox="0 0 16 6"><circle cx="2" cy="1.5" r="1"/><circle cx="8" cy="1.5" r="1"/><circle cx="14" cy="1.5" r="1"/><circle cx="2" cy="4.5" r="1"/><circle cx="8" cy="4.5" r="1"/><circle cx="14" cy="4.5" r="1"/></svg>
      <div class="head-r">
        <span class="chip" data-tip="Hyperliquid market data feed. Live = updating 10 times a second."><span class="dot"></span><span class="livetxt">Offline</span></span>
        <button class="btn" data-act="chart" data-tip="Show or hide the lines Paper Route draws on papertrade's chart">${ICON_CHART}</button>
        <button class="btn" data-act="collapse" data-tip="Collapse the panel. Alt+W hides it completely.">${ICON_COLLAPSE}</button>
      </div>
    </div>
    <div class="body">
      <div class="ref">
        <div class="ref-l">
          <span class="mkt-row" data-tip="Hyperliquid's mid price. Papertrade fills at this price, so it's the price your stops and take profits use."><b class="mkt">—</b><span class="tag">Hyperliquid mid</span></span>
          <span class="px">—</span>
        </div>
      </div>
      <section class="flow collapsed">
        <div class="sec-h" data-act="toggle"><span class="cap" data-tip="What it's for: picking a papertrade side that's likelier to lose. You earn Paper by losing on papertrade while the Hyperliquid hedge makes it back, so you want papertrade on the wrong side of the next move. This reads Hyperliquid's order book and trades for which way price leans over the next 10 to 60 seconds. It's a short-term tilt only: it says nothing beyond about a minute.">${ICON_CHEVRON}Order flow</span><span class="cap-r fx-lead" data-tip="Which way the order flow leans right now, for the next 10 to 60 seconds">—</span></div>
        <div class="fx-lean" data-tip="Price leaning up favours a papertrade short: it's likelier to lose (earning Paper) while its Hyperliquid long gains. Leaning down favours a papertrade long. A short-term tilt only, so it helps most when your papertrade order fills quickly.">
          <span class="fx-lean-v">—</span>
          <span class="fx-lean-t">—</span>
        </div>
        <div class="fx-regime" data-tip="How fast the market is moving: 10-minute volatility of 1-second moves. Calm, normal or wild. The order-flow read is least reliable when it's wild."><span class="lbl">Volatility</span><span class="regime">—</span></div>
        <div class="fx-gauge-h"><span class="lbl" data-tip="Which way Hyperliquid's price leans, from −100 (down) to +100 (up), and the expected price 10, 30 and 60 seconds out. Green is up, red is down, grey is no clear lean.">Price lean</span></div>
        <div class="fx-gauge" data-tip="−100 to +100. Green = the book and trades lean up, red = down, grey = no clear lean."><div class="fx-track"><i class="fx-fill"></i><b class="fx-needle"></b></div><span class="fx-score">—</span></div>
        <div class="ladder" data-tip="Expected move and price in 10, 30 and 60 seconds according to the order-flow read"></div>
        <details class="fx-more">
          <summary data-tip="The order-book and trade readings the lean is built from">See the inputs <span class="hx-chev">›</span></summary>
          <div class="fx-comps"></div>
        </details>
        <div class="fx-note"></div>
      </section>
    </div>
    <div class="foot"><a class="model" href="https://wayfinder.ai" target="_blank" rel="noopener" data-tip="Paper Route is built by Wayfinder. Market data comes from Hyperliquid's public feed.">Built by Wayfinder ↗</a><span class="err"></span><span class="meta">—</span></div>`;
  // one tooltip bubble for the whole panel: any element with data-tip (hedge-ui uses it too)
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  root.append(style, overlay, hud, tip);
  document.documentElement.append(host);

  let tipFor = null;
  function showTip(target) {
    const text = target?.dataset.tip;
    if (!text) return hideTip();
    tipFor = target;
    tip.textContent = text;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
    const above = r.top - t.height - 8 >= 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${above ? r.top - t.height - 8 : r.bottom + 8}px`;
  }
  function hideTip() {
    tipFor = null;
    tip.hidden = true;
  }
  hud.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t !== tipFor) showTip(t);
  });
  hud.addEventListener("mouseleave", hideTip);
  hud.addEventListener("focusin", (e) => showTip(e.target.closest("[data-tip]")));
  hud.addEventListener("focusout", hideTip);
  hud.addEventListener("pointerdown", hideTip);

  const $ = (sel) => hud.querySelector(sel);
  const els = {
    mkt: $(".mkt"), dot: $(".dot"), liveTxt: $(".livetxt"), px: $(".ref .px"), regime: $(".regime"),
    lead: $(".fx-lead"), leanV: $(".fx-lean-v"), leanT: $(".fx-lean-t"), fill: $(".fx-fill"), needle: $(".fx-needle"), score: $(".fx-score"),
    ladder: $(".ladder"), comps: $(".fx-comps"), note: $(".fx-note"), meta: $(".meta"), err: $(".err"),
    chartBtn: $('[data-act="chart"]'),
  };
  const rowEls = new Map();
  const compEls = new Map();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureRows(horizons) {
    const key = horizons.map((h) => h.s).join(",");
    if (els.ladder.dataset.key === key) return;
    els.ladder.dataset.key = key;
    els.ladder.textContent = "";
    rowEls.clear();
    for (const h of horizons) {
      const row = el("div", "row");
      const bar = el("span", "bar");
      const fill = el("i");
      bar.append(fill);
      row.append(el("span", "h", `${h.s}s`), bar, el("span", "bps"), el("span", "tp"));
      els.ladder.append(row);
      rowEls.set(h.s, { row, fill, bps: row.children[2], tp: row.children[3] });
    }
  }

  function ensureComps(used) {
    const key = used.join(",");
    if (els.comps.dataset.key === key) return;
    els.comps.dataset.key = key;
    els.comps.textContent = "";
    compEls.clear();
    for (const c of COMPONENTS) {
      const k = c.keys.find((x) => used.includes(x)) ?? c.keys[0];
      const row = el("div", "fx-c");
      row.dataset.tip = c.hint;
      const name = el("span", "fx-cn", c.label);
      const win = WINDOW_OF(k);
      if (win) name.append(el("small", null, ` ${win}`));
      const meter = el("span", "fx-cm");
      const bar = el("i");
      meter.append(bar);
      const val = el("span", "fx-cv");
      row.append(name, meter, val);
      if (!used.includes(k) && used.length) row.classList.add("unused");
      els.comps.append(row);
      compEls.set(c.label, { key: k, unit: c.unit, bar, val, row });
    }
  }

  const frameListeners = [];

  // projection horizons: the index's, shown only where the published fit has skill
  function shownHorizons(f) {
    return (f.index?.horizons ?? []).filter((h) => h.show).sort((a, b) => a.s - b.s);
  }

  function leanTone(f) {
    const s = f.index?.score ?? 0;
    return Math.abs(s) < LEAN_AT ? tone.idle : s > 0 ? tone.up : tone.down;
  }

  function renderHud() {
    const f = state.frame;
    if (!f) return;
    for (const fn of frameListeners) fn(f);
    els.mkt.textContent = `${f.coin}-USD`;
    if (f.stale || !f.mid) {
      els.score.textContent = "—";
      els.note.textContent = f.feed === "live" ? "Waiting for the order book…" : "Hyperliquid feed reconnecting…";
      return;
    }
    const [int, cents] = fmtPx(f.mid).split(".");
    els.px.textContent = int;
    els.px.append(el("span", "c", `.${cents}`));

    const left = f.warmLeftS ? `${Math.max(1, Math.ceil(f.warmLeftS / 60))}m` : "";
    els.regime.textContent = f.regime ? `${f.regime} · ${f.x.vol_600s.toFixed(2)} bp` : `Warming · ${left || "…"}`;
    els.regime.className = `regime ${f.regime === "wild" ? "dn" : f.regime === "calm" ? "up" : ""}`;

    const idx = f.index;
    const used = idx ? idx.components.map((c) => c.name) : [];
    ensureComps(used);
    const byName = new Map((idx?.components ?? []).map((c) => [c.name, c]));
    for (const c of compEls.values()) {
      const v = f.x[c.key];
      const comp = byName.get(c.key);
      c.val.textContent = fmtVal(v, c.unit);
      // bar: standardised value when the index uses it, else a soft scale on the raw value
      const z = comp ? comp.z : Number.isFinite(v) ? v / (c.unit === "" ? 0.5 : 2) : 0;
      const w = Math.min(1, Math.abs(z) / 3);
      c.bar.style.width = `${w * 50}%`;
      c.bar.style.left = z >= 0 ? "50%" : `${50 - w * 50}%`;
      // colour = which way it pushes the index (contribution sign), grey when it isn't used
      const push = comp ? Math.sign(comp.contrib) : 0;
      c.bar.className = push > 0 ? "up" : push < 0 ? "dn" : "idle";
    }

    if (!idx) {
      els.lead.textContent = "components only";
      els.score.textContent = "—";
      els.fill.style.width = "0";
      els.needle.style.left = "50%";
      els.ladder.hidden = true;
      els.leanV.textContent = "No pick";
      els.leanV.className = "fx-lean-v";
      els.leanT.textContent = "No model for this market yet";
      els.note.textContent = "No published index weights for this market yet. The inputs are live, the combined lean isn't.";
      return;
    }
    const s = idx.score;
    const leadH = idx.horizons.find((h) => h.s === idx.lead);
    // The play is to lose on papertrade (which earns Paper) while Hyperliquid wins, so the
    // papertrade side to pick is the one against the lean: price leaning up → papertrade short.
    const up = Math.abs(s) < LEAN_AT ? null : s > 0;
    const ptSide = up === null ? null : up ? "short" : "long";
    // coloured like papertrade's own buttons: short red, long green
    const sideTone = ptSide === "long" ? "up" : ptSide === "short" ? "dn" : "";
    els.lead.textContent = ptSide ? `Favours papertrade ${ptSide}` : "No clear pick";
    els.lead.className = `cap-r fx-lead ${sideTone}`;
    els.leanV.textContent = ptSide ? `Papertrade ${ptSide}` : "No clear pick";
    els.leanV.className = `fx-lean-v ${sideTone}`;
    els.leanT.textContent = up === null
      ? `Price isn't leaning either way${f.provisional ? " · provisional" : ""}`
      : `Price leans ${up ? "up" : "down"}, next 10–60s${f.provisional ? " · provisional" : ""}`;
    els.leanT.dataset.tip = leadH?.ic != null ? `IC ${leadH.ic.toFixed(2)} at ${idx.lead}s: how well this read has matched the next moves historically (0 = no skill, 1 = perfect)` : "";
    els.score.textContent = `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(0)}`;
    els.score.className = `fx-score ${Math.abs(s) < LEAN_AT ? "" : s > 0 ? "up" : "dn"}`;
    const w = Math.abs(s) / 100;
    els.fill.style.width = `${w * 50}%`;
    els.fill.style.left = s >= 0 ? "50%" : `${50 - w * 50}%`;
    els.fill.className = `fx-fill ${Math.abs(s) < LEAN_AT ? "idle" : s > 0 ? "up" : "dn"}`;
    els.needle.style.left = `${50 + s / 2}%`;

    const hs = shownHorizons(f);
    els.ladder.hidden = !hs.length;
    ensureRows(hs);
    const scale = Math.max(0.3, ...hs.map((h) => Math.abs(h.ret_bps)));
    const cls = Math.abs(s) < LEAN_AT ? "idle" : s > 0 ? "up" : "dn";
    for (const h of hs) {
      const r = rowEls.get(h.s);
      r.bps.textContent = fmtBps(h.ret_bps);
      r.bps.className = `bps ${cls}`;
      r.tp.textContent = fmtPx(f.mid * Math.exp(h.ret_bps / 1e4));
      r.fill.className = `${h.ret_bps >= 0 ? "up" : "dn"} ${cls === "idle" ? "idle" : ""}`;
      r.fill.style.transform = `scaleX(${Math.max(0.04, Math.min(1, Math.abs(h.ret_bps) / scale))})`;
    }
    els.note.textContent = !f.warm
      ? `Warming up: taker flow and the regime need 10 minutes of live data (${f.warmLeftS ? `${Math.ceil(f.warmLeftS / 60)} min left` : "starting"}).`
      : f.provisional
        ? "ETH uses BTC's weights re-scaled to ETH; its own fit needs more ETH history."
        : "";
  }

  function renderStatus() {
    const now = Date.now();
    const f = state.frame;
    const age = f ? now - state.recvMs : Infinity;
    const live = f && f.feed === "live" && !f.stale && age < STALE_MS;
    const cls = live ? "ok" : f ? "stale" : "";
    els.dot.className = `dot ${cls}`;
    els.liveTxt.textContent = live ? "Live" : f?.feed === "connecting" ? "Connecting" : f ? "Stale" : "Offline";
    state.tickTimes = state.tickTimes.filter((t) => now - t < 1000);
    els.meta.textContent = f ? `${state.tickTimes.length}/s` : "Waiting for Hyperliquid";
    els.chartBtn.classList.toggle("off", !state.overlayEnabled);
  }

  // ---------- chart overlay ----------
  let chartCanvas = null;
  function findChartCanvas() {
    if (chartCanvas?.isConnected) return chartCanvas;
    chartCanvas = document.querySelector(".trade-chart canvas");
    return chartCanvas;
  }

  let overlaySize = "";
  function drawOverlay() {
    const ctx = overlay.getContext("2d");
    const f = state.frame;
    const m = state.map;
    const cv = findChartCanvas();
    if (!state.overlayEnabled || !m || !cv) {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sizeKey = `${rect.left},${rect.top},${rect.width},${rect.height},${dpr}`;
    if (sizeKey !== overlaySize) {
      overlaySize = sizeKey;
      Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      overlay.width = Math.round(rect.width * dpr);
      overlay.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const g = {
      right: m.plotRight,
      bottom: m.plotBottom ?? rect.height,
      axisWidth: rect.width - m.plotRight,
      y: (p) => m.priceSlope * (p - m.price0) + m.priceIntercept,
      x: m.timeSlope == null ? null : (t) => m.timeSlope * (t - m.time0) + m.timeIntercept,
    };
    ctx.textBaseline = "middle";

    const tags = []; // price-axis tags, deconflicted and drawn last
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, g.right, g.bottom);
    ctx.clip();
    drawLevels(ctx, g, tags);
    if (f && !f.stale && f.mid && shownHorizons(f).length) drawProjection(ctx, f, g, tags);
    ctx.restore();
    drawAxisTags(ctx, g, tags);
  }

  function font(size, weight = 500, family = HEADING_FONT) {
    return `${weight} ${size}px ${family}`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  const LEVEL_TONE = { entry: tone.ink, limit: tone.up, stop: tone.down, bust: tone.down, liq: tone.amber };

  // Round / position levels: dashed line with a pill at the far left; off screen, an edge chip.
  function drawLevels(ctx, g, tags) {
    let topX = g.right - 8;
    let bottomX = g.right - 8;
    for (const lv of state.levels) {
      const color = LEVEL_TONE[lv.kind] ?? tone.idle;
      const ly = g.y(lv.price);
      if (ly >= 0 && ly <= g.bottom) {
        ctx.strokeStyle = color(0.85);
        ctx.setLineDash(lv.kind === "entry" ? [2, 3] : [5, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(ly) + 0.5);
        ctx.lineTo(g.right, Math.round(ly) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = font(11, 600);
        const w = ctx.measureText(lv.label).width + 14;
        ctx.fillStyle = color(1);
        roundRect(ctx, 8, ly - 10, w, 20, 10);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.fillText(lv.label, 15, ly + 0.5);
        tags.push({ y: ly, text: fmtPxShort(lv.price), bg: color(1), fg: "#fff" });
      } else {
        const offTop = ly < 0;
        const cy = offTop ? TOP_PILL_Y : g.bottom - 44;
        const w = edgeChip(ctx, offTop ? topX : bottomX, cy, `${offTop ? "↑" : "↓"} ${lv.label}`, lv.price, color);
        if (offTop) topX -= w + 6;
        else bottomX -= w + 6;
      }
    }
  }

  function edgeChip(ctx, rightX, cy, head, price, color) {
    const pad = 10;
    ctx.font = font(11, 600);
    const hw = ctx.measureText(head).width;
    ctx.font = font(11, 500);
    const priceText = fmtPxShort(price);
    const pw = ctx.measureText(priceText).width;
    const w = pad + hw + 8 + pw + pad;
    const x = rightX - w;
    ctx.fillStyle = tone.ink(0.92);
    roundRect(ctx, x, cy - 12, w, 24, 12);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.font = font(11, 600);
    ctx.fillStyle = color(1);
    ctx.fillText(head, x + pad, cy + 0.5);
    ctx.font = font(11, 500);
    ctx.fillStyle = tone.muted(1);
    ctx.fillText(priceText, x + pad + hw + 8, cy + 0.5);
    return w;
  }

  // Horizons go out to 60s but tick view usually shows only a few seconds right of "now".
  // When they don't fit, the future lane is sqrt-compressed into the space that is left and
  // every target gets a horizontal rung to the price axis, so levels read without the time axis.
  function projectionLane(f, g, maxS) {
    const x0 = state.map.dotX ?? (g.x ? g.x(f.ts) : g.right - 120);
    const laneEnd = g.right - 40;
    if (g.x) {
      const linear = (s) => x0 + s * 1000 * state.map.timeSlope;
      if (linear(maxS) <= laneEnd) return { x0, xs: linear, compressed: false };
    }
    const width = Math.max(80, laneEnd - x0);
    return { x0, xs: (s) => x0 + width * Math.sqrt(s / maxS), compressed: true };
  }

  function drawProjection(ctx, f, g, tags) {
    const horizons = shownHorizons(f);
    const last = horizons[horizons.length - 1];
    const lane = projectionLane(f, g, last.s);
    const x0 = lane.x0;
    const y0 = state.map.dotY ?? g.y(f.mid);
    const yOf = (price) => y0 + g.y(price) - g.y(f.mid);
    const priceOf = (h) => f.mid * Math.exp(h.ret_bps / 1e4);
    const pts = horizons.map((h) => ({ h, px: lane.xs(h.s), py: yOf(priceOf(h)) }));
    const end = pts[pts.length - 1];
    const lean = leanTone(f);

    const laneGrad = ctx.createLinearGradient(x0, 0, g.right, 0);
    laneGrad.addColorStop(0, tone.ink(0));
    laneGrad.addColorStop(1, tone.ink(0.05));
    ctx.fillStyle = laneGrad;
    ctx.fillRect(x0, 0, g.right - x0, g.bottom);
    ctx.strokeStyle = tone.ink(0.18);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, 0);
    ctx.lineTo(Math.round(x0) + 0.5, g.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const p of pts) {
      const yy = Math.round(p.py) + 0.5;
      const back = ctx.createLinearGradient(0, 0, p.px, 0);
      back.addColorStop(0, lean(0.15));
      back.addColorStop(0.7, lean(0.32));
      back.addColorStop(1, lean(0.72));
      ctx.strokeStyle = back;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(p.px, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = lean(0.8);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.px, yy);
      ctx.lineTo(g.right, yy);
      ctx.stroke();
    }

    const area = ctx.createLinearGradient(0, Math.min(y0, end.py), 0, Math.max(y0, end.py) + 1);
    const top = last.ret_bps >= 0;
    area.addColorStop(0, lean(top ? 0.22 : 0));
    area.addColorStop(1, lean(top ? 0 : 0.22));
    ctx.fillStyle = area;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    for (const p of pts) ctx.lineTo(p.px, p.py);
    ctx.lineTo(end.px, y0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = tone.ink(0.35);
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(y0) + 0.5);
    ctx.lineTo(g.right, Math.round(y0) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = lean(1);
    ctx.lineWidth = 1.75;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    for (const p of pts) ctx.lineTo(p.px, p.py);
    ctx.stroke();

    for (const p of pts) {
      ctx.fillStyle = lean(0.3);
      ctx.beginPath();
      ctx.arc(p.px, p.py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = lean(1);
      ctx.beginPath();
      ctx.arc(p.px, p.py, 3, 0, Math.PI * 2);
      ctx.fill();
      tags.push({ y: p.py, label: `${p.h.s}s`, text: fmtPxShort(priceOf(p.h)), bg: lean(1), fg: "#fff" });
    }

    if (lane.compressed) {
      ctx.font = font(10, 500);
      ctx.textAlign = "left";
      ctx.fillStyle = tone.ink(0.45);
      ctx.fillText(`next ${last.s}s · √t`, x0 + 6, g.bottom - 10);
    }
  }

  // Vertical stacking for labels so close levels never overlap (keeps order, pushes apart).
  function stack(items, h, minY, maxY) {
    items.sort((a, b) => a.y - b.y);
    let floor = minY;
    for (const it of items) {
      it.top = Math.max(it.y - h / 2, floor);
      floor = it.top + h + 1;
    }
    let ceil = maxY;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.top + h <= ceil) break;
      it.top = ceil - h;
      ceil = it.top - 1;
    }
    return items;
  }

  // Price tags over papertrade's price axis, the same shape as its own last-price tag.
  function drawAxisTags(ctx, g, tags) {
    const h = 16;
    ctx.textBaseline = "middle";
    for (const t of stack(tags, h, 0, g.bottom)) {
      const cy = t.top + h / 2;
      if (Math.abs(cy - t.y) > 1) {
        ctx.strokeStyle = t.bg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(g.right - 34, t.y);
        ctx.lineTo(g.right - 30, cy);
        ctx.stroke();
      }
      ctx.font = font(10, 600);
      const pw = Math.min(g.axisWidth - 2, ctx.measureText(t.text).width + 10);
      if (t.label) {
        const lw = 28;
        ctx.fillStyle = tone.ink(0.9);
        roundRect(ctx, g.right - lw, t.top, lw + 4, h, [3, 0, 0, 3]);
        ctx.fill();
        ctx.fillStyle = tone.fg(0.9);
        ctx.textAlign = "center";
        ctx.fillText(t.label, g.right - lw / 2, cy + 0.5);
      }
      ctx.fillStyle = t.bg;
      roundRect(ctx, g.right + 1, t.top, pw, h, t.label ? [0, 3, 3, 0] : 3);
      ctx.fill();
      ctx.fillStyle = t.fg;
      ctx.textAlign = "left";
      ctx.fillText(t.text, g.right + 5, cy + 0.5);
    }
  }

  // ---------- render loop ----------
  // `hud` = false for chart-geometry updates: papertrade's chart sends one every animation frame.
  function schedule(hud = true) {
    state.hudDirty ||= hud;
    if (state.dirty) return;
    state.dirty = true;
    requestAnimationFrame(() => {
      state.dirty = false;
      if (state.hudDirty) {
        state.hudDirty = false;
        renderHud();
        renderStatus();
      }
      drawOverlay();
    });
  }
  setInterval(renderStatus, 250);

  // remember whether "See more" is open
  const more = hud.querySelector(".fx-more");
  chrome.storage.local.get("fxMoreOpen").then(({ fxMoreOpen }) => (more.open = !!fxMoreOpen));
  more.addEventListener("toggle", () => chrome.storage.local.set({ fxMoreOpen: more.open }));

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.type !== "wf-pt-map") return;
    state.map = e.data;
    schedule(false);
  });
  window.addEventListener("resize", () => {
    overlaySize = "";
    schedule();
  });

  // ---------- market port ----------
  const pageCoin = () => location.pathname.match(/\/trade\/([a-z]+)/i)?.[1]?.toUpperCase() ?? null;
  let port = null;

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "wf-pr-market" });
    } catch {
      // "Extension context invalidated": the extension was reloaded or updated, so this copy is dead.
      // Swap the panel for a reload button, and reload by itself once Chrome has had time to restart
      // the extension (too early and the reloaded page comes up without the panel).
      host.remove();
      showUpdated();
      setTimeout(() => location.reload(), 4000);
      return;
    }
    state.coin = null;
    followCoin();
    port.onMessage.addListener((f) => {
      if (f.kind !== "market" || f.coin !== state.coin) return;
      state.frame = f;
      state.recvMs = Date.now();
      state.tickTimes.push(state.recvMs);
      schedule();
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 500);
    });
  }

  function showUpdated() {
    if (document.getElementById("paper-route-updated")) return;
    const b = document.createElement("button");
    b.id = "paper-route-updated";
    b.textContent = "Paper Route was updated · Reload";
    b.style.cssText = "position:fixed;left:16px;top:16px;z-index:2147483647;padding:8px 14px;border:0;border-radius:10px;font:500 13px system-ui,sans-serif;color:#0b1a12;background:#9be89b;box-shadow:0 8px 24px -8px rgba(0,0,0,.5);cursor:pointer";
    b.addEventListener("click", () => location.reload());
    document.documentElement.append(b);
  }

  // papertrade is a single-page app; switching /trade/btc → /trade/eth re-subscribes
  function followCoin() {
    const coin = pageCoin();
    if (!coin || coin === state.coin || !port) return;
    state.coin = coin;
    state.frame = null;
    port.postMessage({ coin });
    schedule();
  }
  setInterval(followCoin, 500);
  connectPort();

  // ---------- interaction ----------
  // order flow starts folded: it's an optional aid for picking a side
  const flowSec = hud.querySelector("section.flow");
  chrome.storage.local.get({ hudPos: null, hudCollapsed: false, overlayEnabled: true, flowOpen: false }).then((s) => {
    if (s.hudPos) Object.assign(hud.style, { left: `${s.hudPos.left}px`, top: `${s.hudPos.top}px` });
    hud.classList.toggle("collapsed", s.hudCollapsed);
    flowSec.classList.toggle("collapsed", !s.flowOpen);
    state.overlayEnabled = s.overlayEnabled;
    schedule();
  });

  hud.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "collapse") {
      const collapsed = hud.classList.toggle("collapsed");
      chrome.storage.local.set({ hudCollapsed: collapsed });
    } else if (act === "toggle" && e.target.closest("section") === flowSec) {
      chrome.storage.local.set({ flowOpen: !flowSec.classList.toggle("collapsed") });
    } else if (act === "chart") {
      state.overlayEnabled = !state.overlayEnabled;
      chrome.storage.local.set({ overlayEnabled: state.overlayEnabled });
      schedule();
    }
  });

  const head = hud.querySelector(".head");
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = hud.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const left = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx));
      const top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
      Object.assign(hud.style, { left: `${left}px`, top: `${top}px` });
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      const fr = hud.getBoundingClientRect();
      chrome.storage.local.set({ hudPos: { left: Math.round(fr.left), top: Math.round(fr.top) } });
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up, { once: true });
  });

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "KeyW") {
      hud.classList.toggle("hidden");
      e.preventDefault();
    }
  });

  // shared with hedge-ui.js, which runs in the same isolated world
  window.__wfHud = {
    root,
    body: hud.querySelector(".body"),
    flow: flowSec,
    chevron: ICON_CHEVRON,
    el,
    fmtPx,
    fmtPct,
    market: () => state.frame,
    onMarket: (fn) => frameListeners.push(fn),
    // [{ price, label, kind: entry|stop|limit|bust|liq }] drawn on the chart
    setLevels: (levels) => {
      const key = JSON.stringify(levels);
      if (key === state.levelsKey) return;
      state.levelsKey = key;
      state.levels = levels;
      schedule(false);
    },
  };
})();
