// Stop loss / take profit on papertrade's own screens: a TP/SL block in the order ticket (applied to
// the position when that order fills) and a TP/SL chip + editor on every open position. The worker
// (src/exits.js) watches the levels and closes through papertrade's Close button.
//
// Each side has two linked fields, like Hyperliquid's and Bybit's tickets: a trigger price and a
// gain/loss as % return on margin or $ P&L. Whichever was edited last is what's kept.
(() => {
  const hud = window.__prHud;
  const eng = window.__prHedge;
  if (!hud || !eng || window.__prTpslUi) return;
  window.__prTpslUi = true;

  const ICON = chrome.runtime.getURL("assets/icon16.png");
  const TP_PICKS = [25, 50, 100];
  const SL_PICKS = [10, 25, 50];

  // With Tether on, the papertrade leg is meant to lose: losing closes and liquidations mint PAPER
  // (a liquidation on the full margin), and Hyperliquid's opposite side wins it back. So the loss
  // side becomes the exit you aim for ("Bank Paper at", bust by default) and the gain side an
  // optional early exit. With Tether off, it's an ordinary one-sided TP / SL.
  const paperMode = () => {
    const s = eng.snap();
    return !!(s?.dn?.on || s?.auto);
  };
  const PAPER_PICKS = { sl: [25, 50, 75], tp: [10, 25, 50] };
  const LABEL = {
    std: { tp: "Take profit", sl: "Stop loss", tpOff: "Off", slOff: "Off" },
    paper: { tp: "Win exit (TP)", sl: "Bank Paper at (SL)", tpOff: "Off", slOff: "At bust" },
  };
  const labels = () => LABEL[paperMode() ? "paper" : "std"];

  // says which set of labels is showing, and why: they follow the Tether switch in the HUD
  function modeLine(el) {
    const paper = paperMode();
    el.textContent = paper ? "Tether on" : "Tether off";
    el.title = paper
      ? "Set up to earn Paper. Tether hedges this on Hyperliquid, so the papertrade side is meant to lose: a losing close or a liquidation mints PAPER, and Hyperliquid's opposite side wins it back. Turn Tether off in the HUD for an ordinary take profit / stop loss."
      : "Standard take profit / stop loss. Tether is off, so nothing is hedged on Hyperliquid. Turn Tether on in the HUD to set these up for earning Paper.";
    el.dataset.tip = el.title;
    el.className = `${el.className.split(" ")[0]} ${paper ? "on" : ""}`;
  }

  const fmtPx = (p) => (p == null || !Number.isFinite(p) ? "" : p.toLocaleString("en-US", { maximumFractionDigits: p >= 1000 ? 1 : 2, useGrouping: false }));
  const fmtPxShow = (p) => p.toLocaleString("en-US", { maximumFractionDigits: p >= 1000 ? 1 : 2 });
  const fmtUsd = (v) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
  const pageCoin = () => location.pathname.match(/\/trade\/([a-z]+)/i)?.[1]?.toUpperCase() ?? null;
  const num = (v) => {
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return v !== "" && Number.isFinite(n) && n > 0 ? n : null;
  };

  // ---------- maths: base = { isLong, entry, size, margin, bust } ----------
  const sign = (side) => (side === "tp" ? 1 : -1);
  function priceFrom(side, base, amount, unit) {
    const usd = unit === "roe" ? (amount / 100) * base.margin : amount;
    return base.entry + (sign(side) * (base.isLong ? 1 : -1) * usd) / base.size;
  }
  function pnlAt(base, price) {
    return (price - base.entry) * (base.isLong ? 1 : -1) * base.size;
  }
  function amountFrom(side, base, price, unit) {
    const usd = pnlAt(base, price) * sign(side); // positive when the level is on the right side
    return unit === "roe" ? (usd / base.margin) * 100 : usd;
  }
  function problem(side, base, price) {
    if (price == null || !base) return null;
    const right = side === "tp" ? (base.isLong ? price > base.entry : price < base.entry) : base.isLong ? price < base.entry : price > base.entry;
    const L = labels();
    if (!right) return side === "tp" ? `${L.tp} must be ${base.isLong ? "above" : "below"} entry` : `${L.sl} must be ${base.isLong ? "below" : "above"} entry`;
    if (side === "sl" && base.bust && (base.isLong ? price <= base.bust : price >= base.bust)) {
      return paperMode() ? `Past papertrade's liquidation (${fmtPxShow(base.bust)}): pick At bust instead` : `Past papertrade's liquidation (${fmtPxShow(base.bust)}): it would bust first`;
    }
    return null;
  }

  // ---------- one side's linked fields ----------
  function sideRow(side, { light }) {
    const st = { edited: null, price: null, amount: null, unit: "roe" };
    const wrap = document.createElement("div");
    wrap.className = light ? "pr-side" : "pe-side";
    const head = document.createElement("div");
    head.className = light ? "pr-side-h" : "pe-side-h";
    const name = document.createElement("span");
    const est = document.createElement("span");
    est.className = light ? "pr-est" : "pe-est";
    head.append(name, est);
    const fields = document.createElement("div");
    fields.className = light ? "pr-fields" : "pe-fields";
    const price = document.createElement("input");
    price.inputMode = "decimal";
    price.placeholder = side === "tp" ? "TP price" : "SL price";
    const amtBox = document.createElement("div");
    amtBox.className = light ? "pr-amt" : "pe-amt";
    const amount = document.createElement("input");
    amount.inputMode = "decimal";
    amount.placeholder = side === "tp" ? "Gain" : "Loss";
    const unit = document.createElement("button");
    unit.type = "button";
    unit.textContent = "%";
    unit.title = "Switch between % return on margin and $ P&L";
    amtBox.append(amount, unit);
    fields.append(price, amtBox);
    const picks = document.createElement("div");
    picks.className = light ? "pr-picks" : "pe-picks";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.addEventListener("click", () => {
      Object.assign(st, { edited: null, price: null, amount: null });
      sync();
    });
    // labels, pick values and "off" wording follow the mode (see LABEL); rebuilt only when it flips
    let mode = null;
    function relabel() {
      const paper = paperMode();
      if (mode === paper) return;
      mode = paper;
      const L = labels();
      name.textContent = L[side];
      name.title = !paper
        ? ""
        : side === "sl"
          ? "Where to close both legs at a papertrade loss: that loss mints PAPER while Hyperliquid's opposite side wins it back. At bust lets papertrade liquidate, which mints on the full margin."
          : "Close both legs if papertrade moves into profit instead. A winning close earns no PAPER; while hedged, the pair stays neutral if you wait.";
      price.placeholder = paper ? "Price" : side === "tp" ? "TP price" : "SL price";
      clear.textContent = L[`${side}Off`];
      clear.title = !paper
        ? `No ${L[side].toLowerCase()}`
        : side === "sl"
          ? "No early close: let papertrade liquidate. A liquidation mints PAPER on the full margin, and the safety net closes Hyperliquid at the same price."
          : "Hold through papertrade gains (the pair stays neutral while you wait for it to turn)";
      const values = paper ? PAPER_PICKS[side] : side === "tp" ? TP_PICKS : SL_PICKS;
      picks.replaceChildren(...values.map((v) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = `${v}%`;
        b.title = !paper
          ? `${L[side]} at ${v}% ${side === "tp" ? "gain" : "loss"} on margin`
          : side === "sl"
            ? `Close both legs once papertrade is down ${v}% of margin: that loss mints PAPER`
            : `Close both legs if papertrade gets ${v}% up on margin (a winning close earns no PAPER)`;
        b.addEventListener("click", () => {
          Object.assign(st, { edited: "amount", unit: "roe", amount: v });
          sync();
        });
        return b;
      }), clear);
    }
    const warn = document.createElement("div");
    warn.className = light ? "pr-warn" : "pe-warn";
    wrap.append(head, fields, picks, warn);

    let getBase = () => null;
    function sync() {
      relabel();
      const base = getBase();
      unit.textContent = st.unit === "roe" ? "%" : "$";
      if (st.edited === "price" && base) st.amount = st.price != null ? amountFrom(side, base, st.price, st.unit) : null;
      if (st.edited === "amount" && base) st.price = st.amount != null ? priceFrom(side, base, st.amount, st.unit) : null;
      if (document.activeElement !== price) price.value = st.price != null ? fmtPx(st.price) : "";
      if (document.activeElement !== amount) amount.value = st.amount != null ? String(Math.round(st.amount * 100) / 100) : "";
      const p = st.edited ? st.price : null;
      // in Paper mode a papertrade loss is the aim, so it reads as the good outcome
      const pnl = p != null && base ? pnlAt(base, p) : null;
      const paperLoss = mode && pnl != null && pnl < 0;
      const away = pnl != null ? Math.abs(p / base.entry - 1) * 100 : null;
      // whole dollars from $10 up keeps the label on one line in papertrade's narrow ticket
      const usdText = pnl != null && Math.abs(pnl) >= 10 ? `${pnl < 0 ? "−" : "+"}$${Math.round(Math.abs(pnl))}` : pnl != null ? fmtUsd(pnl) : "";
      est.textContent = pnl != null ? `${usdText} · ${away < 1 ? away.toFixed(2) : away.toFixed(1)}%` : "";
      est.title = pnl != null ? `${fmtUsd(pnl)} on $${base.margin} margin, ${away.toFixed(2)}% from ${st.edited === "amount" && light ? "the current price (worked out from the fill price when the order fills)" : "entry"}. Higher leverage means a smaller move for the same amount.` : "";
      est.className = `${light ? "pr-est" : "pe-est"} ${pnl != null ? (pnl >= 0 !== !!paperLoss ? "up" : "dn") : ""}`;
      warn.textContent = (st.edited && problem(side, base, p)) || "";
      for (const b of picks.children) b.classList.toggle("on", b === clear ? !st.edited : st.edited === "amount" && st.unit === "roe" && `${st.amount}%` === b.textContent);
    }
    price.addEventListener("input", () => {
      Object.assign(st, { edited: num(price.value) == null ? null : "price", price: num(price.value) });
      sync();
    });
    amount.addEventListener("input", () => {
      Object.assign(st, { edited: num(amount.value) == null ? null : "amount", amount: num(amount.value) });
      sync();
    });
    unit.addEventListener("click", () => {
      const base = getBase();
      if (st.amount != null && base) {
        const usd = st.unit === "roe" ? (st.amount / 100) * base.margin : st.amount;
        st.amount = st.unit === "roe" ? usd : (usd / base.margin) * 100;
      }
      st.unit = st.unit === "roe" ? "usd" : "roe";
      sync();
    });

    return {
      el: wrap,
      bind(fn) {
        getBase = fn;
      },
      sync,
      // order ticket: what to resolve at fill; editor: the absolute price
      target: () => (st.edited === "price" ? { kind: "price", value: st.price } : st.edited === "amount" ? { kind: st.unit, value: st.amount } : null),
      price: () => (st.edited ? st.price : null),
      problem: () => (st.edited ? problem(side, getBase(), st.price) : null),
      setPrice(px) {
        Object.assign(st, { edited: px == null ? null : "price", price: px });
        sync();
      },
    };
  }

  // a level is a trigger, not a resting order: say so in bold wherever levels are set
  function triggerNote() {
    const b = document.createElement("b");
    b.textContent = "Triggers, not orders:";
    b.title = "Once the price moves past your level, Paper Route sends the close, which is still subject to papertrade's queue and fill delays.";
    return b;
  }

  // ---------- order ticket block ----------
  const style = document.createElement("style");
  style.textContent = `
    .pr-tpsl [hidden], .pr-tpsl[hidden] { display: none !important; }
    .pr-tpsl { margin: 8px 0 10px; padding: 8px 10px; border-radius: 10px; background: rgba(139, 32, 32, 0.035); box-shadow: inset 0 0 0 1px rgba(139, 32, 32, 0.22); font: 13px/1.4 Inter, system-ui, sans-serif; color: #2a2520; }
    .pr-tpsl-h { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
    .pr-tpsl-h input { margin: 0; accent-color: #8b2020; }
    .pr-tpsl-h b { font-weight: 600; letter-spacing: 0.02em; }
    .pr-badge { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: rgb(143, 134, 118); }
    .pr-badge img { width: 14px; height: 14px; border-radius: 3px; }
    .pr-tpsl-b { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .pr-dn { margin-bottom: 6px; }
    .pr-dn + .pr-tpsl { margin-top: 0; }
    .pr-info { color: rgb(160, 150, 134); font-size: 11px; cursor: help; }
    .pr-tip { position: fixed; z-index: 2147483647; max-width: 260px; padding: 7px 9px; border-radius: 8px; background: #1d1b19; color: #f3efe6; font: 12px/1.4 Inter, system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25); pointer-events: none; }
    .pr-tip[hidden] { display: none; }
    .pr-toast { position: fixed; right: 24px; bottom: 24px; z-index: 2147483646; width: 300px; padding: 12px 14px; border-radius: 12px; background: #1d1b19; color: #f3efe6; font: 12.5px/1.45 Inter, system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); }
    .pr-toast[hidden] { display: none; }
    .pr-toast-h { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; font-weight: 600; }
    .pr-toast-h img { width: 14px; height: 14px; border-radius: 3px; }
    .pr-toast-h button { margin-left: auto; border: 0; background: none; color: #a39a8b; font-size: 16px; line-height: 1; cursor: pointer; }
    .pr-toast-big { font: 600 18px/1.3 Inter, system-ui, sans-serif; margin-bottom: 6px; }
    .pr-toast-row { display: flex; justify-content: space-between; gap: 10px; color: #c9c0b1; }
    .pr-toast-row b { color: #f3efe6; font-weight: 500; }
    .pr-toast-sub { margin-left: 10px; font-size: 11.5px; color: #8f8676; }
    .pr-toast .up { color: #7fd49a; } .pr-toast .dn { color: #f28b82; }
    .pr-side { display: flex; flex-direction: column; gap: 4px; }
    .pr-side-h { display: flex; justify-content: space-between; gap: 6px; white-space: nowrap; font-size: 12px; color: rgb(143, 134, 118); font-weight: 500; }
    .pr-est.up { color: #2f6b3f; } .pr-est.dn { color: #8b2020; }
    .pr-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .pr-fields input { width: 100%; box-sizing: border-box; height: 30px; padding: 0 9px; border: 1px solid rgba(58, 53, 48, 0.18); border-radius: 8px; background: #fbf8f0; font: 13px Inter, system-ui, sans-serif; color: #2a2520; outline: none; }
    .pr-fields input:focus { border-color: rgba(139, 32, 32, 0.55); }
    .pr-amt { position: relative; }
    .pr-amt input { padding-right: 34px; }
    .pr-amt button { position: absolute; right: 4px; top: 4px; height: 26px; min-width: 26px; padding: 0 6px; border: 0; border-radius: 6px; background: rgba(58, 53, 48, 0.08); font: 600 12px Inter, system-ui, sans-serif; color: #2a2520; cursor: pointer; }
    .pr-picks { display: flex; gap: 4px; }
    .pr-picks button { flex: 1; min-width: 0; padding: 0 2px; white-space: nowrap; height: 22px; border: 1px solid rgba(58, 53, 48, 0.14); border-radius: 6px; background: transparent; font: 500 11px Inter, system-ui, sans-serif; color: rgb(110, 102, 90); cursor: pointer; }
    .pr-picks button.on { border-color: #8b2020; color: #8b2020; background: rgba(139, 32, 32, 0.06); }
    .pr-warn { font-size: 11.5px; color: #8b2020; }
    .pr-warn:empty { display: none; }
    .pr-fit { margin-top: 8px; padding: 6px 8px; border-radius: 6px; font-size: 12px; line-height: 1.4; color: #8b2020; background: rgba(139, 32, 32, 0.07); }
    .pr-note { font-size: 11.5px; color: rgb(143, 134, 118); }
    .pr-note b { color: #2a2520; font-weight: 600; }
    .pr-pending { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 12px; color: #2f6b3f; }
    .pr-pending button { border: 0; background: none; color: rgb(143, 134, 118); cursor: pointer; font: 12px Inter, system-ui, sans-serif; text-decoration: underline; }
    .pr-chip { display: inline-flex; align-items: center; gap: 5px; margin-left: 10px; height: 22px; padding: 0 8px; border: 1px solid rgba(139, 32, 32, 0.28); border-radius: 999px; background: rgba(139, 32, 32, 0.04); font: 500 11.5px Inter, system-ui, sans-serif; color: #2a2520; cursor: pointer; white-space: nowrap; vertical-align: middle; }
    .pr-chip:hover { background: rgba(139, 32, 32, 0.09); }
    .pr-chip img { width: 12px; height: 12px; border-radius: 3px; }
    .pr-chip .tp { color: #2f6b3f; } .pr-chip .sl { color: #8b2020; }
    .pr-chip.add { color: rgb(110, 102, 90); border-style: dashed; }
    .pr-mode { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap; color: rgb(110, 102, 90); background: rgba(58, 53, 48, 0.07); cursor: help; }
    .pr-mode::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: rgba(58, 53, 48, 0.35); }
    .pr-mode.on { color: #2f6b3f; background: rgba(47, 107, 63, 0.1); }
    .pr-mode.on::before { background: #2f6b3f; }
    .pr-chip.off { color: #fff; background: #8b2020; border-color: #8b2020; }
    .pr-dn-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: rgb(143, 134, 118); font-weight: 500; }
    .pr-dn-row > span { flex: none; width: 58px; }
    .pr-dn-row .pr-picks { flex: 1; }
    .pr-dn-open { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 8px 7px 10px; border-radius: 8px; background: rgba(58, 53, 48, 0.05); font-size: 12px; line-height: 1.35; color: #2a2520; }
    .pr-dn-open span { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .pr-dn-open span::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: #2f6b3f; }
    .pr-dn-open button { flex: none; height: 26px; padding: 0 12px; border: 1px solid rgba(139, 32, 32, 0.45); border-radius: 999px; background: transparent; color: #8b2020; font: 500 12px Inter, system-ui, sans-serif; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
    .pr-dn-open button:hover { background: rgba(139, 32, 32, 0.07); border-color: #8b2020; }
    .pr-dn-open button:disabled { opacity: 0.5; cursor: default; }
    .pr-dn-err { font-size: 11.5px; color: #8b2020; }
    .pr-dn-err:empty { display: none; }
    .pr-dn > .pr-dn-err { margin-top: 6px; }
    .pr-auto { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #2a2520; cursor: pointer; }
    .pr-auto input { margin: 0; accent-color: #8b2020; }
    .pr-offline { margin-top: 8px; padding: 6px 8px; border-radius: 6px; background: #8b2020; color: #fff; font-size: 12px; font-weight: 600; }
  `;
  document.head.append(style);

  const ticket = document.createElement("div");
  ticket.className = "pr-tpsl";
  const tHead = document.createElement("label");
  tHead.className = "pr-tpsl-h";
  tHead.title = "Papertrade has no TP/SL. Paper Route watches these levels and closes the position for you.";
  const tOn = document.createElement("input");
  tOn.type = "checkbox";
  const tTitle = document.createElement("b");
  tTitle.textContent = "TP / SL";
  const badge = document.createElement("span");
  badge.className = "pr-badge";
  const badgeImg = document.createElement("img");
  badgeImg.src = ICON;
  badge.title = "Added by Paper Route";
  badge.append(badgeImg);
  const tMode = document.createElement("span");
  tMode.className = "pr-mode";
  modeLine(tMode);
  tHead.append(tOn, tTitle, tMode, badge);
  const tBody = document.createElement("div");
  tBody.className = "pr-tpsl-b";
  tBody.hidden = true;
  const tTp = sideRow("tp", { light: true });
  const tSl = sideRow("sl", { light: true });
  const tNote = document.createElement("div");
  tNote.className = "pr-note";
  function ticketNote() {
    const info = document.createElement("span");
    info.className = "pr-info";
    info.textContent = " ⓘ";
    info.dataset.prTip = "Once the price crosses your level, Paper Route sends the close, which still waits in papertrade's queue, so it can fill past your level. Keep Chrome open and Paper Route enabled while levels are set.";
    tNote.replaceChildren(triggerNote(), " closes through papertrade's queue", info);
  }
  ticketNote();
  tBody.append(tTp.el, tSl.el, tNote);
  const tPending = document.createElement("div");
  tPending.className = "pr-pending";
  tPending.hidden = true;
  const tOffline = document.createElement("div");
  tOffline.className = "pr-offline";
  tOffline.hidden = true;
  // shown whether or not TP/SL is ticked: a papertrade order Hyperliquid couldn't hedge
  const tFit = document.createElement("div");
  tFit.className = "pr-fit";
  tFit.hidden = true;
  ticket.append(tHead, tOffline, tBody, tPending, tFit);
  // ---------- hover hints ----------
  // papertrade's page swallows or delays native title tooltips; show our own, immediately
  const tip = document.createElement("div");
  tip.className = "pr-tip";
  tip.hidden = true;
  document.body.append(tip);
  const tipText = (el) => el?.dataset?.prTip || el?.getAttribute?.("title") || "";
  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.(".pr-tpsl [data-pr-tip], .pr-tpsl [title]");
    const text = tipText(el);
    if (!el || !text) return void (tip.hidden = true);
    if (el.hasAttribute("title")) {
      el.dataset.prTip = el.getAttribute("title"); // keep the text, drop the native (delayed) tooltip
      el.removeAttribute("title");
    }
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = Math.min(260, tip.offsetWidth);
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    const above = r.top - tip.offsetHeight - 8;
    tip.style.top = `${above > 8 ? above : r.bottom + 8}px`;
  });
  document.addEventListener("pointerout", (e) => {
    if (!e.relatedTarget?.closest?.(".pr-tpsl [data-pr-tip]")) tip.hidden = true;
  });

  // ---------- delta neutral block (above TP / SL) ----------
  const COVERAGES = [0.25, 0.5, 0.75, 1];
  const dnBox = document.createElement("div");
  dnBox.className = "pr-tpsl pr-dn";
  const dnHead = document.createElement("label");
  dnHead.className = "pr-tpsl-h";
  dnHead.title = "Hedge this papertrade position with an opposite one, on Hyperliquid or on papertrade itself, so price moves cancel out.";
  const dnOn = document.createElement("input");
  dnOn.type = "checkbox";
  const dnTitle = document.createElement("b");
  dnTitle.textContent = "Delta neutral";
  const dnBadge = badge.cloneNode(true);
  const dnInfo = document.createElement("span");
  dnInfo.className = "pr-info";
  dnInfo.textContent = "ⓘ";
  dnHead.append(dnOn, dnTitle, dnInfo, dnBadge);
  const dnBody = document.createElement("div");
  dnBody.className = "pr-tpsl-b";
  dnBody.hidden = true;
  const seg = (items, onPick) => {
    const box = document.createElement("div");
    box.className = "pr-picks";
    for (const [value, text, tip] of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.dataset.v = String(value);
      if (tip) b.title = tip;
      b.addEventListener("click", () => onPick(value));
      box.append(b);
    }
    box.select = (value) => {
      for (const b of box.children) b.classList.toggle("on", b.dataset.v === String(value));
    };
    return box;
  };
  const dnErr = document.createElement("div");
  dnErr.className = "pr-dn-err";
  const setDn = (patch) => {
    dnErr.textContent = "";
    eng.send("setDeltaNeutral", { coin: pageCoin(), ...patch }).catch((e) => (dnErr.textContent = String(e.message || e)));
  };
  const venueSeg = seg(
    [
      ["hl", "Hyperliquid", "Tether: Hyperliquid opens the opposite side when papertrade fills, and closes it when papertrade closes."],
      ["pt", "Papertrade", "An opposite papertrade position, placed together with your order."],
    ],
    (venue) => setDn({ venue }),
  );
  const coverSeg = seg(COVERAGES.map((c) => [c, `${c * 100}%`, `Hedge ${c * 100}% of the position`]), (coverage) => setDn({ coverage }));
  const row = (label, el, tip) => {
    const r = document.createElement("div");
    r.className = "pr-dn-row";
    const l = document.createElement("span");
    l.textContent = label;
    if (tip) l.title = tip;
    r.append(l, el);
    return r;
  };
  const dnOpen = document.createElement("div");
  dnOpen.className = "pr-dn-open";
  dnOpen.hidden = true;
  dnBody.append(row("Hedge on", venueSeg), row("Coverage", coverSeg, "How much of the papertrade position the hedge covers"), dnOpen);
  dnBox.append(dnHead, dnBody, dnErr); // errors show even when the block is closed (e.g. turning it on failed)
  dnOn.addEventListener("change", () => setDn({ on: dnOn.checked }));

  // with delta neutral: closing at a TP / SL closes both legs, unless switched off here
  const autoRow = document.createElement("label");
  autoRow.className = "pr-auto";
  autoRow.title = "On: when a stop loss or take profit closes the position, the hedge closes with it, and if one leg closes or is liquidated the other is closed too. Off: only the papertrade position closes and the hedge is left to run.";
  const autoBox = document.createElement("input");
  autoBox.type = "checkbox";
  autoRow.append(autoBox, "Auto close both legs");
  autoBox.addEventListener("change", () => setDn({ autoClose: autoBox.checked }));
  tBody.prepend(autoRow);

  function closeBothButton(text, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await onClick();
      } catch (e) {
        dnErr.textContent = String(e.message || e);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  function renderDn(s) {
    const dn = s?.dn;
    dnBox.hidden = !s;
    if (!dn) return;
    dnOn.checked = !!dn.on;
    dnBody.hidden = !dn.on;
    venueSeg.select(dn.venue);
    coverSeg.select(dn.coverage);
    autoRow.hidden = !dn.on;
    autoBox.checked = dn.autoClose !== false;
    const cov = `${Math.round(dn.coverage * 100)}%`;
    dnInfo.dataset.prTip =
      dn.venue === "hl"
        ? `Hyperliquid opens the opposite of ${cov} of every papertrade fill on this coin and closes it when papertrade closes (Tether). Set Hyperliquid leverage in the panel.`
        : `With your order, Paper Route places an opposite papertrade order with ${cov} of its margin at the same leverage. Both wait in papertrade's queue, so they can fill at different times and prices.`;
    const coin = pageCoin();
    dnOpen.replaceChildren();
    const pair = (s.pairs?.pairs ?? []).find((p) => p.coin === coin);
    const pend = (s.pairs?.pending ?? []).find((p) => p.coin === coin);
    if (dn.on && dn.venue === "pt" && pair) {
      const t = document.createElement("span");
      t.textContent = `Pair open: ${pair.mainIsLong ? "long" : "short"} ${pair.mainId} ↔ ${pair.mainIsLong ? "short" : "long"} ${pair.hedgeId}${pair.state === "closing" ? " · closing…" : ""}`;
      dnOpen.append(t, closeBothButton("Close both", () => eng.send("closeBoth", { positionId: pair.mainId, coin })));
    } else if (dn.on && dn.venue === "pt" && pend) {
      const t = document.createElement("span");
      t.textContent = `Pair placed: waiting for both legs to fill${pend.mainId || pend.hedgeId ? " (one has)" : ""}`;
      dnOpen.append(t);
    } else if (dn.on && dn.venue === "hl" && s.auto && (s.ptPositions ?? []).length) {
      const t = document.createElement("span");
      t.textContent = `Hedged on Hyperliquid: ${s.ptPositions.length} papertrade position${s.ptPositions.length > 1 ? "s" : ""}`;
      dnOpen.append(t, closeBothButton("Close both", async () => {
        // closing papertrade is enough: Tether closes the Hyperliquid hedge when the close fills
        for (const p of s.ptPositions) await eng.send("closeBoth", { positionId: p.id, coin });
      }));
    }
    dnOpen.hidden = !dnOpen.children.length;
  }

  function renderFit() {
    const b = ticketBase();
    const f = b ? eng.fit({ isLong: b.isLong, margin: b.margin, leverage: Math.round((b.size * b.entry) / b.margin) }) : null;
    tFit.textContent = f && !f.ok ? f.text : "";
    tFit.hidden = !tFit.textContent;
  }
  function renderOffline(s) {
    const coin = location.pathname.match(/\/trade\/([a-z]+)/i)?.[1]?.toUpperCase();
    tOffline.textContent = !s
      ? "⚠ Paper Route is offline: no TP/SL is being watched. Reload it in chrome://extensions, then refresh this page."
      : s.pageCheck && !s.pageCheck.ok
        ? `⚠ Papertrade's page changed (${s.pageCheck.problems.join("; ")}): Paper Route may not be able to close at your levels. Watch your positions.`
        : s.exits?.unwatched?.includes(coin)
          ? `⚠ No ${coin} price for a while: TP/SL can't trigger until it's back (retrying).`
          : "";
    tOffline.hidden = !tOffline.textContent;
  }

  chrome.storage.local.get("tpslTicketOn").then(({ tpslTicketOn }) => {
    tOn.checked = !!tpslTicketOn;
    tBody.hidden = !tOn.checked;
  });
  tOn.addEventListener("change", () => {
    tBody.hidden = !tOn.checked;
    chrome.storage.local.set({ tpslTicketOn: tOn.checked });
  });

  // what the order would be: from papertrade's own ticket, priced at the current mid
  function ticketBase() {
    const margin = Number(document.getElementById("im")?.value);
    const lev = Number(document.getElementById("il")?.value);
    const m = hud.market();
    const mid = m && m.coin === pageCoin() ? m.mid : null;
    if (!(margin > 0) || !(lev > 0) || !mid) return null;
    const isLong = document.querySelector("button.dup")?.getAttribute("aria-pressed") === "true";
    const bustRow = [...document.querySelectorAll("#preTrade .trade-summary-row")].find((r) => /Bust Price/.test(r.textContent));
    const bust = Number(bustRow?.textContent.replace(/^[^$]*\$/, "").replace(/[^0-9.]/g, "")) || null;
    return { isLong, entry: mid, size: (margin * lev) / mid, margin, bust };
  }
  tTp.bind(ticketBase);
  tSl.bind(ticketBase);

  function placeTicket() {
    const pre = document.getElementById("preTrade");
    if (!pre || ticket.parentElement === pre.parentElement) return;
    pre.after(dnBox, ticket);
  }

  // arm the levels when papertrade's own Place Trade is clicked (capture: before papertrade handles it)
  document.addEventListener(
    "click",
    (e) => {
      const go = e.target.closest?.("#go");
      if (!go || go.disabled || !tOn.checked || eng.placingOrder()) return;
      const tp = tTp.target();
      const sl = tSl.target();
      if (!tp && !sl) return;
      const bad = [tTp.problem(), tSl.problem()].find((p) => p && !/liquidation/.test(p));
      if (bad) return; // shown under the field; the order still goes through without TP/SL
      const base = ticketBase();
      eng.send("armExit", { isLong: base?.isLong ?? document.querySelector("button.dup")?.getAttribute("aria-pressed") === "true", tp, sl }).catch(() => {});
    },
    true,
  );

  // delta neutral on papertrade: right after the user's order, place the opposite papertrade order with
  // coverage × its margin at the same leverage, then put the ticket back as it was
  document.addEventListener(
    "click",
    (e) => {
      const go = e.target.closest?.("#go");
      if (!go || go.disabled || eng.placingOrder()) return;
      const dn = eng.snap()?.dn;
      if (!dn?.on || dn.venue !== "pt") return;
      const coin = pageCoin();
      const margin = Number(document.getElementById("im")?.value);
      const leverage = Number(document.getElementById("il")?.value);
      const isLong = document.querySelector("button.dup")?.getAttribute("aria-pressed") === "true";
      if (!coin || !(margin > 0) || !(leverage > 0)) return;
      const hedgeMargin = Math.round(margin * dn.coverage * 100) / 100;
      eng.send("armPair", { coin, mainIsLong: isLong }).catch(() => {});
      setTimeout(async () => {
        dnErr.textContent = "";
        try {
          // papertrade takes the user's click first; wait for its ticket to be ready again
          await eng.settle(() => {
            const g = document.querySelectorAll("#go");
            return g.length === 1 && !g[0].disabled;
          }, 5000);
          await eng.ptOpen({ coin, isLong: !isLong, marginUsd: hedgeMargin, leverage });
        } catch (err) {
          dnErr.textContent = `Hedge leg not placed: ${err.message || err}. Your ${isLong ? "long" : "short"} is unhedged.`;
        } finally {
          await new Promise((r) => setTimeout(r, 400));
          eng.restoreTicket({ isLong, marginUsd: margin }).catch(() => {});
        }
      }, 150);
    },
    true,
  );

  // ---------- toast: what a finished delta-neutral trade cost per Paper ----------
  const toast = document.createElement("div");
  toast.className = "pr-toast";
  toast.hidden = true;
  document.body.append(toast);
  let toastShownAt = Date.now() - 2 * 60_000; // on load, only show a summary from the last two minutes
  let toastTimer = null;
  const money = (v) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
  function line(label, value, cls = "", sub = false) {
    const r = document.createElement("div");
    r.className = sub ? "pr-toast-row pr-toast-sub" : "pr-toast-row";
    const b = document.createElement("b");
    b.textContent = value;
    if (cls) b.className = cls;
    r.append(label, b);
    return r;
  }
  function showToast(c) {
    const head = document.createElement("div");
    head.className = "pr-toast-h";
    const img = document.createElement("img");
    img.src = ICON;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.addEventListener("click", () => (toast.hidden = true));
    head.append(img, `${c.coin} delta-neutral trade closed${c.liquidated ? " (a leg was liquidated)" : ""}`, x);
    const big = document.createElement("div");
    big.className = "pr-toast-big";
    const paper = Math.round(c.paper).toLocaleString();
    big.textContent =
      c.costPerPaper == null
        ? `${money(c.net)} · no Paper minted`
        : c.costPerPaper >= 0
          ? `$${c.costPerPaper.toFixed(4)} per Paper`
          : `Paid $${(-c.costPerPaper).toFixed(4)} per Paper`;
    const rows = [line("Paper earned", paper), line(c.venue === "hl" ? "Papertrade P&L (after its cut)" : "Papertrade P&L, both legs", money(c.ptPaid), c.ptPaid >= 0 ? "up" : "dn")];
    if (c.hl) {
      rows.push(line("Hyperliquid hedge", money(c.hl.net), c.hl.net >= 0 ? "up" : "dn"));
      rows.push(line("P&L", money(c.hl.pnl), "", true));
      rows.push(line(`Fees${c.hl.builder ? ` (incl. $${c.hl.builder.toFixed(2)} builder)` : ""}`, money(-c.hl.fees), "", true));
      if (Math.abs(c.hl.funding) >= 0.005) rows.push(line("Funding", money(c.hl.funding), "", true));
    }
    rows.push(line("Net", money(c.net), c.net >= 0 ? "up" : "dn"));
    toast.replaceChildren(head, big, ...rows);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 15_000);
  }
  function renderToast(s) {
    const c = s?.dnSummary;
    if (!c || c.at <= toastShownAt) return;
    toastShownAt = c.at;
    showToast(c);
  }

  function renderPending(s) {
    const p = s?.exits?.pending;
    tPending.hidden = !p;
    if (!p) return;
    tPending.textContent = "";
    const t = document.createElement("span");
    const [tpTag, slTag] = paperMode() ? ["Win exit", "Paper at"] : ["TP", "SL"];
    const what = [p.tp && `${tpTag} ${p.tp.kind === "price" ? fmtPxShow(p.tp.value) : p.tp.kind === "roe" ? `+${p.tp.value}%` : `+$${p.tp.value}`}`, p.sl && `${slTag} ${p.sl.kind === "price" ? fmtPxShow(p.sl.value) : p.sl.kind === "roe" ? `−${p.sl.value}%` : `−$${p.sl.value}`}`].filter(Boolean).join(" · ");
    t.textContent = `✓ ${what} waiting for your ${p.isLong ? "long" : "short"} to fill`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => eng.send("armExit", {}));
    tPending.append(t, cancel);
  }

  // ---------- position chips + editor ----------
  const editor = hud.el("div", "pe");
  editor.hidden = true;
  hud.root.append(editor);
  let editing = null; // positionId

  function chipFor(row) {
    // the row's buttons carry the position: "Close BTC position 525988" / "Details for BTC position 525988"
    const btn = row.querySelector('button[aria-label*=" position "]');
    const m = btn?.getAttribute("aria-label")?.match(/(\w+) position (\d+)$/);
    if (!m) return;
    const [, coin, id] = m;
    const cell = row.querySelector(".pt-asset-cell");
    if (!cell) return;
    let chip = cell.querySelector(".pr-chip");
    if (!chip) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.className = "pr-chip";
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditor(chip.dataset.id, chip.dataset.coin, chip);
      });
      cell.append(chip);
    }
    chip.dataset.id = id;
    chip.dataset.coin = coin;
    const s = eng.snap();
    // offline, or no price for this coin: say so rather than look like "nothing set"
    const off = !s ? "Paper Route offline" : s.exits?.unwatched?.includes(coin) ? "TP/SL not watched" : null;
    const x = s?.exits?.byPosition?.[id];
    const paper = paperMode();
    const key = off ? `off|${off}` : x ? `${x.tpPx}|${x.slPx}|${x.state}|${paper}` : `add|${paper}`;
    if (chip.dataset.key === key) return;
    chip.dataset.key = key;
    chip.textContent = "";
    const img = document.createElement("img");
    img.src = ICON;
    chip.append(img);
    chip.classList.toggle("add", !x && !off);
    chip.classList.toggle("off", !!off);
    if (off) {
      chip.title = !s
        ? "Paper Route's background isn't running, so no stop loss or take profit is being watched. Reload the extension in chrome://extensions, then refresh papertrade."
        : `No ${coin} price has come in for a while, so its levels can't trigger. Paper Route keeps retrying.`;
      return chip.append(`⚠ ${off}`);
    }
    chip.title = paper
      ? x ? "Exits watched by Paper Route. Click to edit." : "Set where to bank Paper, or an exit if papertrade wins (watched by Paper Route)"
      : x ? "Stop loss / take profit watched by Paper Route. Click to edit." : "Add a stop loss or take profit (watched by Paper Route)";
    if (!x) return chip.append(paper ? "Exits" : "TP/SL");
    if (x.state === "closing") return chip.append(`Closing (${x.reason})…`);
    // TP then SL in both modes; in Paper mode the loss level is the goal, so it takes the positive colour
    const slSpan = x.slPx != null && Object.assign(document.createElement("span"), { className: paper ? "tp" : "sl", textContent: `${paper ? "Paper at" : "SL"} ${fmtPxShow(x.slPx)}` });
    const tpSpan = x.tpPx != null && Object.assign(document.createElement("span"), { className: paper ? "sl" : "tp", textContent: `${paper ? "Win exit" : "TP"} ${fmtPxShow(x.tpPx)}` });
    const parts = [tpSpan, slSpan].filter(Boolean);
    parts.forEach((sp, i) => chip.append(...(i ? [" · ", sp] : [sp])));
  }

  function scanRows() {
    placeTicket();
    for (const row of document.querySelectorAll(".pt-virtual-row")) chipFor(row);
  }

  const eTp = sideRow("tp", { light: false });
  const eSl = sideRow("sl", { light: false });

  function openEditor(id, coin, anchor) {
    const s = eng.snap();
    const p = s?.ptPositions?.find((x) => x.id === id);
    editing = id;
    editor.textContent = "";
    const head = hud.el("div", "pe-h");
    const title = hud.el("b", null, paperMode() ? "Exits" : "TP / SL");
    const mode = hud.el("span", "pe-mode");
    modeLine(mode);
    title.append(mode);
    const close = hud.el("button", "pe-x", "×");
    close.type = "button";
    close.addEventListener("click", closeEditor);
    head.append(title, close);
    editor.append(head);
    if (!p) {
      editor.append(hud.el("p", "pe-sub", coin !== s?.settings.coin ? `Open the ${coin} page to edit this position's exits.` : "Waiting for this position's details…"));
    } else {
      const base = { isLong: p.isLong, entry: p.entry, size: p.size, margin: p.margin, bust: p.bust };
      editor.append(hud.el("p", "pe-sub", `${p.coin} ${p.isLong ? "long" : "short"} ${p.leverage}× · entry ${fmtPxShow(p.entry)} · liquidation ${fmtPxShow(p.bust)}`));

      eTp.bind(() => base);
      eSl.bind(() => base);
      const x = s.exits?.byPosition?.[id];
      eTp.setPrice(x?.tpPx ?? null);
      eSl.setPrice(x?.slPx ?? null);
      const err = hud.el("div", "pe-err");
      const save = hud.el("button", "pbtn primary", "Save");
      save.type = "button";
      const remove = hud.el("button", "pbtn", "Remove");
      remove.type = "button";
      remove.hidden = !x;
      save.addEventListener("click", async () => {
        const bad = [eTp.problem(), eSl.problem()].find(Boolean);
        if (bad) return (err.textContent = bad);
        try {
          await eng.send("setExit", { positionId: id, tpPx: eTp.price(), slPx: eSl.price() });
          closeEditor();
        } catch (e) {
          err.textContent = String(e.message || e);
        }
      });
      remove.addEventListener("click", async () => {
        await eng.send("setExit", { positionId: id, tpPx: null, slPx: null }).catch((e) => (err.textContent = String(e.message || e)));
        closeEditor();
      });
      const actions = hud.el("div", "pe-actions");
      actions.append(save, remove);
      eTp.sync();
      eSl.sync();
      editor.append(eTp.el, eSl.el, err, actions);
      const tether = s.auto ? " Tether closes the Hyperliquid side when papertrade's close fills." : " Hyperliquid isn't touched.";
      const note = hud.el("p", "pe-note");
      note.append(triggerNote(), ` Paper Route closes once price crosses your level, through papertrade's queue. Keep Chrome open.${tether}`);
      editor.append(note);
    }
    editor.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = 320;
    editor.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
    const below = r.bottom + 8 + editor.offsetHeight < window.innerHeight;
    editor.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - editor.offsetHeight - 8)}px`;
  }

  function closeEditor() {
    editing = null;
    editor.hidden = true;
  }
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeEditor());
  // clicks inside the editor stay inside (its shadow root hides it from the document's view of the event)
  editor.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.addEventListener("pointerdown", (e) => {
    if (!editing || e.target.closest?.(".pr-chip")) return;
    closeEditor();
  });

  // papertrade re-renders its ticket and (virtualised) position rows: keep our pieces attached
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scanRows();
    }, 50);
  }).observe(document.body, { childList: true, subtree: true });
  let lastPaper = null;
  eng.onSnap((s) => {
    renderDn(s);
    renderToast(s);
    scanRows();
    renderPending(s);
    renderOffline(s);
    if (paperMode() !== lastPaper) {
      lastPaper = paperMode();
      modeLine(tMode);
      ticketNote();
      for (const r of [tTp, tSl, eTp, eSl]) r.sync();
    }
  });
  // before the first snapshot arrives the worker may simply not be there
  setTimeout(() => renderOffline(eng.snap()), 4000);
  setInterval(() => {
    tTp.sync();
    tSl.sync();
    renderFit();
  }, 500);
  document.addEventListener("input", (e) => {
    if (e.target.id === "im" || e.target.id === "il") {
      tTp.sync();
      tSl.sync();
    }
  }, true);
  scanRows();
})();
