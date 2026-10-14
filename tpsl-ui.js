// Stop loss / take profit on papertrade's own screens: a TP/SL block in the order ticket (applied to
// the position when that order fills) and a TP/SL chip + editor on every open position. The worker
// (src/exits.js) watches the levels and closes through papertrade's Close button.
//
// Each side has two linked fields, like Hyperliquid's and Bybit's tickets: a trigger price and a
// gain/loss as % return on margin or $ P&L. Whichever was edited last is what's kept.
(() => {
  const hud = window.__wfHud;
  const eng = window.__wfHedge;
  if (!hud || !eng || window.__wfTpslUi) return;
  window.__wfTpslUi = true;

  const ICON = chrome.runtime.getURL("assets/icon16.png");
  const TP_PICKS = [25, 50, 100];
  const SL_PICKS = [10, 25, 50];

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
    if (!right) return side === "tp" ? `Take profit must be ${base.isLong ? "above" : "below"} entry` : `Stop loss must be ${base.isLong ? "below" : "above"} entry`;
    if (side === "sl" && base.bust && (base.isLong ? price <= base.bust : price >= base.bust)) return `Past papertrade's liquidation (${fmtPxShow(base.bust)}): it would bust first`;
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
    name.textContent = side === "tp" ? "Take profit" : "Stop loss";
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
    for (const v of side === "tp" ? TP_PICKS : SL_PICKS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${v}%`;
      b.title = `${side === "tp" ? "Take profit" : "Stop loss"} at ${v}% ${side === "tp" ? "gain" : "loss"} on margin`;
      b.addEventListener("click", () => {
        Object.assign(st, { edited: "amount", unit: "roe", amount: v });
        sync();
      });
      picks.append(b);
    }
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Off";
    clear.title = "No " + (side === "tp" ? "take profit" : "stop loss");
    clear.addEventListener("click", () => {
      Object.assign(st, { edited: null, price: null, amount: null });
      sync();
    });
    picks.append(clear);
    const warn = document.createElement("div");
    warn.className = light ? "pr-warn" : "pe-warn";
    wrap.append(head, fields, picks, warn);

    let getBase = () => null;
    function sync() {
      const base = getBase();
      unit.textContent = st.unit === "roe" ? "%" : "$";
      if (st.edited === "price" && base) st.amount = st.price != null ? amountFrom(side, base, st.price, st.unit) : null;
      if (st.edited === "amount" && base) st.price = st.amount != null ? priceFrom(side, base, st.amount, st.unit) : null;
      if (document.activeElement !== price) price.value = st.price != null ? fmtPx(st.price) : "";
      if (document.activeElement !== amount) amount.value = st.amount != null ? String(Math.round(st.amount * 100) / 100) : "";
      const p = st.edited ? st.price : null;
      est.textContent = p != null && base ? `${fmtUsd(pnlAt(base, p))}${st.edited === "amount" && light ? " est." : ""}` : "";
      est.className = `${light ? "pr-est" : "pe-est"} ${p != null && base ? (pnlAt(base, p) >= 0 ? "up" : "dn") : ""}`;
      warn.textContent = (st.edited && problem(side, base, p)) || "";
      for (const b of picks.children) b.classList.toggle("on", st.edited === "amount" && st.unit === "roe" && `${st.amount}%` === b.textContent);
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
    b.textContent = "These are triggers, not orders: once the price moves past your level, Paper Route sends the close, which is still subject to papertrade's queue and fill delays.";
    return b;
  }

  // ---------- order ticket block ----------
  const style = document.createElement("style");
  style.textContent = `
    .pr-tpsl [hidden], .pr-tpsl[hidden] { display: none !important; }
    .pr-tpsl { margin: 10px 0 12px; padding: 10px 12px; border-radius: 10px; background: rgba(139, 32, 32, 0.035); box-shadow: inset 0 0 0 1px rgba(139, 32, 32, 0.22); font: 13px/1.4 Inter, system-ui, sans-serif; color: #2a2520; }
    .pr-tpsl-h { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
    .pr-tpsl-h input { margin: 0; accent-color: #8b2020; }
    .pr-tpsl-h b { font-weight: 600; letter-spacing: 0.02em; }
    .pr-badge { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: rgb(143, 134, 118); }
    .pr-badge img { width: 14px; height: 14px; border-radius: 3px; }
    .pr-tpsl-b { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
    .pr-side { display: flex; flex-direction: column; gap: 5px; }
    .pr-side-h { display: flex; justify-content: space-between; font-size: 12px; color: rgb(143, 134, 118); font-weight: 500; }
    .pr-est.up { color: #2f6b3f; } .pr-est.dn { color: #8b2020; }
    .pr-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .pr-fields input { width: 100%; box-sizing: border-box; height: 34px; padding: 0 9px; border: 1px solid rgba(58, 53, 48, 0.18); border-radius: 8px; background: #fbf8f0; font: 13px Inter, system-ui, sans-serif; color: #2a2520; outline: none; }
    .pr-fields input:focus { border-color: rgba(139, 32, 32, 0.55); }
    .pr-amt { position: relative; }
    .pr-amt input { padding-right: 34px; }
    .pr-amt button { position: absolute; right: 4px; top: 4px; height: 26px; min-width: 26px; padding: 0 6px; border: 0; border-radius: 6px; background: rgba(58, 53, 48, 0.08); font: 600 12px Inter, system-ui, sans-serif; color: #2a2520; cursor: pointer; }
    .pr-picks { display: flex; gap: 4px; }
    .pr-picks button { flex: 1; height: 24px; border: 1px solid rgba(58, 53, 48, 0.14); border-radius: 6px; background: transparent; font: 500 11px Inter, system-ui, sans-serif; color: rgb(110, 102, 90); cursor: pointer; }
    .pr-picks button.on { border-color: #8b2020; color: #8b2020; background: rgba(139, 32, 32, 0.06); }
    .pr-warn { font-size: 11.5px; color: #8b2020; }
    .pr-warn:empty { display: none; }
    .pr-note { font-size: 11.5px; color: rgb(143, 134, 118); }
    .pr-note b { color: #2a2520; font-weight: 600; }
    .pr-pending { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 12px; color: #2f6b3f; }
    .pr-pending button { border: 0; background: none; color: rgb(143, 134, 118); cursor: pointer; font: 12px Inter, system-ui, sans-serif; text-decoration: underline; }
    .pr-chip { display: inline-flex; align-items: center; gap: 5px; margin-left: 10px; height: 22px; padding: 0 8px; border: 1px solid rgba(139, 32, 32, 0.28); border-radius: 999px; background: rgba(139, 32, 32, 0.04); font: 500 11.5px Inter, system-ui, sans-serif; color: #2a2520; cursor: pointer; white-space: nowrap; vertical-align: middle; }
    .pr-chip:hover { background: rgba(139, 32, 32, 0.09); }
    .pr-chip img { width: 12px; height: 12px; border-radius: 3px; }
    .pr-chip .tp { color: #2f6b3f; } .pr-chip .sl { color: #8b2020; }
    .pr-chip.add { color: rgb(110, 102, 90); border-style: dashed; }
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
  badge.append(badgeImg, "Paper Route");
  tHead.append(tOn, tTitle, badge);
  const tBody = document.createElement("div");
  tBody.className = "pr-tpsl-b";
  tBody.hidden = true;
  const tTp = sideRow("tp", { light: true });
  const tSl = sideRow("sl", { light: true });
  const tNote = document.createElement("div");
  tNote.className = "pr-note";
  tNote.append(
    triggerNote(),
    " Set when this order fills (from the fill price if you use % or $). Watched by Paper Route: keep Chrome open.",
  );
  tBody.append(tTp.el, tSl.el, tNote);
  const tPending = document.createElement("div");
  tPending.className = "pr-pending";
  tPending.hidden = true;
  ticket.append(tHead, tBody, tPending);

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
    pre.after(ticket);
  }

  // arm the levels when papertrade's own Place Trade is clicked (capture: before papertrade handles it)
  document.addEventListener(
    "click",
    (e) => {
      const go = e.target.closest?.("#go");
      if (!go || go.disabled || !tOn.checked) return;
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

  function renderPending(s) {
    const p = s?.exits?.pending;
    tPending.hidden = !p;
    if (!p) return;
    tPending.textContent = "";
    const t = document.createElement("span");
    const what = [p.tp && `TP ${p.tp.kind === "price" ? fmtPxShow(p.tp.value) : p.tp.kind === "roe" ? `+${p.tp.value}%` : `+$${p.tp.value}`}`, p.sl && `SL ${p.sl.kind === "price" ? fmtPxShow(p.sl.value) : p.sl.kind === "roe" ? `−${p.sl.value}%` : `−$${p.sl.value}`}`].filter(Boolean).join(" · ");
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
    const x = eng.snap()?.exits?.byPosition?.[id];
    const key = x ? `${x.tpPx}|${x.slPx}|${x.state}` : "add";
    if (chip.dataset.key === key) return;
    chip.dataset.key = key;
    chip.textContent = "";
    const img = document.createElement("img");
    img.src = ICON;
    chip.append(img);
    chip.classList.toggle("add", !x);
    chip.title = x ? "Stop loss / take profit watched by Paper Route. Click to edit." : "Add a stop loss or take profit (watched by Paper Route)";
    if (!x) return chip.append("TP/SL");
    if (x.state === "closing") return chip.append(`Closing (${x.reason})…`);
    if (x.tpPx != null) chip.append(Object.assign(document.createElement("span"), { className: "tp", textContent: `TP ${fmtPxShow(x.tpPx)}` }));
    if (x.tpPx != null && x.slPx != null) chip.append(" · ");
    if (x.slPx != null) chip.append(Object.assign(document.createElement("span"), { className: "sl", textContent: `SL ${fmtPxShow(x.slPx)}` }));
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
    const title = hud.el("b", null, "TP / SL");
    const close = hud.el("button", "pe-x", "×");
    close.type = "button";
    close.addEventListener("click", closeEditor);
    head.append(title, close);
    editor.append(head);
    if (!p) {
      editor.append(hud.el("p", "pe-sub", coin !== s?.settings.coin ? `Open the ${coin} page to edit this position's TP/SL.` : "Waiting for this position's details…"));
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
      editor.append(eTp.el, eSl.el, err, actions);
      const tether = s.auto ? "Tether closes the Hyperliquid hedge when papertrade's close fills." : "Tether is off, so Hyperliquid won't be touched.";
      const note = hud.el("p", "pe-note");
      note.append(triggerNote(), ` Watched by Paper Route and closed with papertrade's Close button: keep Chrome open. ${tether}`);
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
  eng.onSnap((s) => {
    scanRows();
    renderPending(s);
  });
  setInterval(() => {
    tTp.sync();
    tSl.sync();
  }, 500);
  document.addEventListener("input", (e) => {
    if (e.target.id === "im" || e.target.id === "il") {
      tTp.sync();
      tSl.sync();
    }
  }, true);
  scanRows();
})();
