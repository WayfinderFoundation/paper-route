// HUD hedge + rounds sections. Renders hedge-engine snapshots from the service worker and sends
// commands back. Every fund-moving command goes through an inline confirm row first.
(() => {
  const hud = window.__wfHud;
  if (!hud || window.__wfHedgeUi) return;
  window.__wfHedgeUi = true;
  const { el, fmtPx } = hud;

  const usd = (v, d = 2) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  const usdK = (v) => (Math.abs(v) >= 1000 ? `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(1)}K` : usd(v, 0));
  const signed = (v, d = 2) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(d)}`;
  const qty = (v) => `${Math.abs(v).toFixed(4)}`;
  const tone = (v) => (v > 0 ? "up" : v < 0 ? "dn" : "");
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

  // ---------- DOM ----------
  const card = el("section", "hedge");
  card.innerHTML = `
    <div class="sec-h hedge-h" data-act="toggle">
      <span class="cap">Tether · Hyperliquid</span>
      <span class="hx-chips"><span class="badge hx-signer">—</span></span>
    </div>
    <div class="hx-body">
      <div class="hx-lev">
        <span class="lbl">HL leverage</span>
        <div class="seg hx-levs"></div>
        <div class="seg hx-mode"><button data-act="mode" data-cross="1">Cross</button><button data-act="mode" data-cross="0">Iso</button></div>
      </div>
      <div class="hx-empty"></div>
      <div class="hx-main">
        <div class="hx-legs">
          <div class="hx-leg"><span class="lbl">Papertrade</span><span class="hx-pt">—</span></div>
          <div class="hx-leg"><span class="lbl">Hyperliquid</span><span class="hx-hl">—</span></div>
        </div>
        <div class="hx-delta">
          <div class="bar wide"><i></i></div>
          <div class="hx-delta-t"><span class="hx-dtext">—</span><span class="hx-pct">—</span></div>
        </div>
        <div class="hx-plan"></div>
        <div class="hx-actions">
          <button class="pbtn primary" data-act="hedge">Hedge to 100%</button>
          <label class="switch" title="Keeps Hyperliquid at minus your papertrade position. Papertrade queues orders, so the hedge moves when a papertrade open or close actually fills, not when you click."><input type="checkbox" class="hx-auto" /><span></span><em>Tether</em></label>
        </div>
        <div class="hx-why">Tether keeps Hyperliquid at −(papertrade position). It reacts to papertrade fills, not clicks, so queued orders never leave you one-sided.</div>
        <div class="hx-grid">
          <span class="lbl">Paper P&amp;L</span><span class="hx-ptpnl">—</span>
          <span class="lbl">HL P&amp;L</span><span class="hx-hlpnl">—</span>
          <span class="lbl">Net</span><span class="hx-net-pnl">—</span>
          <span class="lbl">Paper bust</span><span class="hx-bust">—</span>
          <span class="lbl">HL liq</span><span class="hx-liq">—</span>
        </div>
        <div class="hx-netline" title="Resting reduce-only orders on Hyperliquid at papertrade's liquidation prices: if papertrade busts while this browser is closed, the hedge closes with it."></div>
        <div class="hx-bal">
          <div><span class="lbl">Paper avail.</span><b class="hx-ptav">—</b><small class="hx-ptq"></small></div>
          <div><span class="lbl">HL equity</span><b class="hx-hleq">—</b><small class="hx-hlw"></small></div>
        </div>
        <div class="hx-rebal">
          <span class="hx-sugg">—</span>
          <div class="hx-rebal-row">
            <input class="field hx-amt" type="number" min="1" step="1" placeholder="USDC" />
            <button class="pbtn" data-act="toPt">→ Papertrade</button>
            <button class="pbtn" data-act="toHl">→ Hyperliquid</button>
          </div>
        </div>
      </div>
      <div class="hx-confirm" hidden>
        <span class="hx-confirm-t"></span>
        <div><button class="pbtn primary" data-act="confirm">Confirm</button><button class="pbtn" data-act="cancel">Cancel</button></div>
      </div>
      <div class="hx-unlock" hidden>
        <input class="field hx-pass" type="password" placeholder="Main key passphrase (for transfers)" autocomplete="off" />
        <button class="pbtn" data-act="unlock">Unlock</button>
      </div>
      <div class="hx-alerts"></div>
    </div>`;
  hud.body.append(card);

  // ---------- schedule section ----------
  const LEVELS = [0.1, 0.2, 0.35, 1];
  const sched = el("section", "sched");
  sched.innerHTML = `
    <div class="sec-h"><span class="cap">Round</span><span class="cap-r sc-clock"></span></div>
    <div class="sg-trade" hidden>
      <div class="sg-trade-top"><b class="sg-trade-t"></b><span class="badge sg-trade-state"></span></div>
      <div class="sg-trade-d"></div>
      <div class="sg-trade-pnl"></div>
      <button class="pbtn exit" data-act="exit">Close both legs</button>
    </div>
    <div class="sc-form">
      <div class="sc-row">
        <span class="lbl">Paper side</span>
        <div class="seg sc-side"><button data-act="side" data-v="long" class="on">Long</button><button data-act="side" data-v="short">Short</button></div>
      </div>
      <div class="sc-row">
        <label class="sc-num"><span class="lbl">Margin $</span><input class="field sc-margin" type="number" min="1" step="1" /></label>
        <label class="sc-num"><span class="lbl">Paper lev.</span><input class="field sc-lev" type="number" min="1" step="1" /></label>
      </div>
      <div class="sc-cap">
        <span class="sc-cap-t">Waiting for balances…</span>
        <button class="pbtn sm" data-act="max">Max</button>
      </div>
      <div class="sc-row"><span class="lbl">Stop</span><div class="seg sc-stop"></div><input class="field sc-pct sc-stop-c" type="number" min="0.01" max="50" step="0.01" placeholder="%" title="Custom stop, % from papertrade's fill" /></div>
      <div class="sc-row"><span class="lbl">Take profit</span><div class="seg sc-limit"></div><input class="field sc-pct sc-limit-c" type="number" min="0.01" max="50" step="0.01" placeholder="%" title="Custom take profit, % from papertrade's fill" /></div>
      <div class="sc-watch">Stop and take profit are watched by this browser, not placed on papertrade or Hyperliquid. Keep Chrome open and Paper Route enabled until the round closes.</div>
      <div class="sc-row">
        <label class="switch"><input type="checkbox" class="sc-hedge" checked /><span></span><em>Hedge on Hyperliquid (opens and closes on papertrade's fills)</em></label>
      </div>
      <div class="sc-row sc-when">
        <button class="pbtn primary sc-now" data-act="open-now">Open now</button>
        <span class="lbl">or at</span>
        <input class="field sc-time" type="time" step="1" />
        <div class="seg sc-quick"><button data-act="plus" data-s="15">+15s</button><button data-act="plus" data-s="60">+1m</button><button data-act="plus" data-s="300">+5m</button></div>
        <button class="pbtn sc-go" data-act="schedule">Schedule</button>
      </div>
      <div class="sc-note"></div>
    </div>
    <div class="hx-confirm sc-confirm" hidden>
      <span class="sc-confirm-t"></span>
      <div><button class="pbtn primary" data-act="sc-confirm">Confirm</button><button class="pbtn" data-act="sc-cancel">Cancel</button></div>
    </div>
    <div class="sc-list"></div>`;
  hud.body.append(sched);
  const sq = (s) => sched.querySelector(s);
  for (const [cls, def] of [[".sc-stop", 0.2], [".sc-limit", 0.2]]) {
    sq(cls).replaceChildren(...["off", ...LEVELS].map((l) => {
      const b = el("button", l === def ? "on" : null, l === "off" ? "Off" : `${l}%`);
      b.dataset.act = cls === ".sc-stop" ? "stop" : "limit";
      b.dataset.v = String(l);
      if (l === "off") b.title = cls === ".sc-stop" ? "No stop: papertrade's bust is the only stop" : "No take profit: close it yourself";
      return b;
    }));
  }
  const form = { side: "long", stopPct: 0.2, limitPct: 0.2 };
  // a custom % replaces the chip; clearing it goes back to no chip selected until one is picked
  for (const [cls, key, seg] of [[".sc-stop-c", "stopPct", ".sc-stop"], [".sc-limit-c", "limitPct", ".sc-limit"]]) {
    sq(cls).addEventListener("input", (e) => {
      const v = Number(e.target.value);
      if (!(v > 0)) return;
      form[key] = v;
      setSeg(sq(seg), null);
    });
  }
  const levelText = (v) => (v === null ? "off" : `${v}%`);
  let schedConfirm = null;
  // Size is saved in the extension (chrome.storage.local "tradeSize"); first run prefills from
  // papertrade's own ticket.
  sq(".sc-margin").value = document.getElementById("im")?.value || "100";
  sq(".sc-lev").value = document.getElementById("il")?.value || "100";
  const saveSize = () => {
    const marginUsd = Number(sq(".sc-margin").value);
    const ptLeverage = Math.round(Number(sq(".sc-lev").value));
    if (marginUsd > 0 && ptLeverage >= 1) chrome.storage.local.set({ tradeSize: { marginUsd, ptLeverage } });
  };
  chrome.storage.local.get("tradeSize").then(({ tradeSize }) => {
    if (tradeSize?.marginUsd > 0 && tradeSize?.ptLeverage >= 1) {
      sq(".sc-margin").value = String(tradeSize.marginUsd);
      sq(".sc-lev").value = String(tradeSize.ptLeverage);
    } else saveSize();
  });
  sq(".sc-margin").addEventListener("input", saveSize);
  sq(".sc-lev").addEventListener("input", saveSize);

  const pad = (n) => String(n).padStart(2, "0");
  const toTimeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  function timeToEpoch(v) {
    const [h, m, s = "0"] = v.split(":");
    const d = new Date();
    d.setHours(Number(h), Number(m), Number(s), 0);
    return d.getTime();
  }
  sq(".sc-time").value = toTimeValue(new Date(Date.now() + 60_000));
  // until the user picks a time, keep the default a minute ahead instead of going stale
  let timeTouched = false;
  sq(".sc-time").addEventListener("input", () => (timeTouched = true));

  function setSeg(container, value) {
    for (const b of container.children) b.classList.toggle("on", b.dataset.v === String(value));
  }

  sched.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === "plus") {
        timeTouched = true;
        sq(".sc-time").value = toTimeValue(new Date(Date.now() + Number(btn.dataset.s) * 1000));
      }
      else if (act === "max") {
        const c = formCapacity();
        if (!c) throw new Error("Waiting for papertrade and Hyperliquid balances");
        if (!c.ok) throw new Error(c.problems[0]);
        sq(".sc-margin").value = String(c.maxMargin);
        saveSize();
        renderSchedule();
      } else if (act === "side") setSeg(sq(".sc-side"), (form.side = btn.dataset.v));
      else if (act === "stop" || act === "limit") {
        const key = act === "stop" ? "stopPct" : "limitPct";
        form[key] = btn.dataset.v === "off" ? null : Number(btn.dataset.v);
        setSeg(sq(act === "stop" ? ".sc-stop" : ".sc-limit"), btn.dataset.v);
        sq(act === "stop" ? ".sc-stop-c" : ".sc-limit-c").value = "";
      }
      else if (act === "schedule" || act === "open-now") {
        const now = act === "open-now";
        const spec = {
          at: now ? Date.now() : timeToEpoch(sq(".sc-time").value),
          immediate: now,
          side: form.side,
          marginUsd: Number(sq(".sc-margin").value),
          ptLeverage: Number(sq(".sc-lev").value),
          stopPct: form.stopPct,
          limitPct: form.limitPct,
          hedge: sq(".sc-hedge").checked,
        };
        if (!now && spec.at < Date.now()) throw new Error("That time has passed");
        const c = formCapacity();
        if (!c) throw new Error("Waiting for papertrade and Hyperliquid balances");
        if (!c.ok) throw new Error(c.problems[0]);
        if (spec.marginUsd > c.maxMargin) throw new Error(`Max margin is $${c.maxMargin} — limited by ${c.binding}`);
        if (spec.marginUsd < c.minMargin) throw new Error(`Min margin is $${c.minMargin} at ${spec.ptLeverage}x`);
        const notional = spec.marginUsd * spec.ptLeverage;
        schedConfirm = spec;
        sq(".sc-confirm-t").textContent =
          `${now ? "Now" : `At ${sq(".sc-time").value}`}: papertrade ${snap.settings.coin} ${spec.side} $${spec.marginUsd} × ${spec.ptLeverage}x ($${Math.round(notional).toLocaleString()}), ` +
          `stop ${levelText(spec.stopPct)} / take profit ${levelText(spec.limitPct)}${spec.hedge ? ` · HL hedge at ${snap?.settings.hlLeverage ?? "?"}x, opened/closed on papertrade's fills` : ""}. ` +
          (spec.stopPct === null && spec.limitPct === null
            ? "No exits set: Paper Route closes nothing until you click Close both legs."
            : "Exits are watched by this browser: keep Chrome open and Paper Route enabled until it closes (if the papertrade tab is closed, Paper Route reopens it to close).");
        sq(".sc-confirm").hidden = false;
      } else if (act === "sc-confirm") {
        const spec = schedConfirm;
        schedConfirm = null;
        sq(".sc-confirm").hidden = true;
        // "now" is re-stamped at confirm time, not when the confirm row was shown
        await send("scheduleRound", spec.immediate ? { ...spec, at: Date.now() } : spec);
        flash("ok", spec.immediate ? "Opening…" : "Round scheduled");
      } else if (act === "sc-cancel") {
        schedConfirm = null;
        sq(".sc-confirm").hidden = true;
      } else if (act === "round-cancel") {
        await send("cancelRound", { id: btn.dataset.id });
      } else if (act === "exit") {
        await send("exitRound");
        flash("warn", "Closing both legs…");
      }
    } catch (err) {
      flash("error", String(err.message || err));
    }
  });

  // ---------- capacity: mirrors src/capacity.js roundCapacity (keep in sync) ----------
  const HL_COST_FRACTION = 0.001;

  function roundCapacity(inp, isPaperLong, ptLeverage, hedge) {
    const L = inp.ptLimits;
    const parts = {
      "papertrade balance": inp.ptAvailable * ptLeverage,
      [`papertrade ${isPaperLong ? "long" : "short"} open-interest room`]: isPaperLong ? L.roomLongUsd : L.roomShortUsd,
      "papertrade max position": L.maxPositionNotionalUsd,
      "your max order": inp.maxOrderUsd,
      "your max hedge position": inp.maxPositionUsd,
    };
    if (hedge) parts["Hyperliquid margin"] = inp.hlAvailableToTrade[isPaperLong ? 1 : 0] / (1 / inp.hlLeverage + HL_COST_FRACTION);
    let binding = null;
    let maxNotional = Infinity;
    for (const [name, v] of Object.entries(parts)) {
      if (v < maxNotional) {
        maxNotional = v;
        binding = name;
      }
    }
    maxNotional = Math.max(0, maxNotional);
    const maxMargin = Math.floor((maxNotional / ptLeverage) * 100) / 100;
    const minMargin = Math.ceil(Math.max(L.minMarginUsd, L.minNotionalUsd / ptLeverage) * 100) / 100;
    const problems = [];
    if (ptLeverage > L.maxLeverage) problems.push(`Papertrade max leverage is ${L.maxLeverage}x`);
    if (hedge && inp.hlMaxLeverage && inp.hlLeverage > inp.hlMaxLeverage) problems.push(`Hyperliquid max leverage is ${inp.hlMaxLeverage}x`);
    if (!L.openable) problems.push("Papertrade isn't accepting new positions right now");
    if (maxMargin < minMargin) problems.push(`Needs ≥ $${minMargin} margin ($${Math.round(L.minNotionalUsd).toLocaleString()} min notional) but max is $${maxMargin} (limited by ${binding})`);
    return { maxMargin, minMargin, maxNotional, binding, parts, problems, ok: problems.length === 0 };
  }

  // the form's side and leverage, against both venues' live balances
  function formCapacity() {
    const inp = snap?.capacityInputs;
    const lev = Number(sq(".sc-lev").value);
    if (!inp || !(lev >= 1)) return null;
    return roundCapacity(inp, form.side === "long", lev, sq(".sc-hedge").checked);
  }

  const STATE_TONE = { scheduled: "", opening: "warn", hedging: "warn", live: "up", closing: "warn", flattening: "warn", done: "up", failed: "dn", cancelled: "" };

  function renderSchedule() {
    const now = Date.now();
    if (!timeTouched && timeToEpoch(sq(".sc-time").value) < now + 15_000) sq(".sc-time").value = toTimeValue(new Date(now + 60_000));
    sq(".sc-clock").textContent = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const lev = Number(sq(".sc-lev").value) || 0;
    // papertrade busts at entry × (1 ∓ (1/leverage − bustBuffer)); bustBuffer ≈ 0.0476%
    const bustBuffer = snap?.capacityInputs?.ptLimits.bustBuffer ?? 0.000476;
    const bustPct = lev ? (1 / lev - bustBuffer) * 100 : null;
    sq(".sc-note").textContent = !bustPct
      ? ""
      : form.stopPct === null
        ? `No stop: papertrade busts ${bustPct.toFixed(3)}% away at ${lev}x`
        : form.stopPct >= bustPct
          ? `At ${lev}x papertrade busts ${bustPct.toFixed(3)}% away — a ${form.stopPct}% stop won't be reached first`
          : "";
    sq(".sc-watch").hidden = form.stopPct === null && form.limitPct === null;

    const c = formCapacity();
    const margin = Number(sq(".sc-margin").value);
    const capT = sq(".sc-cap-t");
    let fits = false;
    if (!c) {
      capT.textContent = snap?.capacityInputs === null ? "Set wallets to see the max size" : "Waiting for balances…";
      capT.className = "sc-cap-t";
    } else if (!c.ok) {
      capT.textContent = c.problems[0];
      capT.className = "sc-cap-t dn";
    } else {
      fits = margin >= c.minMargin && margin <= c.maxMargin;
      capT.textContent = `Max $${c.maxMargin.toLocaleString()} ($${Math.floor(c.maxNotional).toLocaleString()} notional) · min $${c.minMargin} — ${c.binding}`;
      capT.className = `sc-cap-t ${fits ? "" : "dn"}`;
    }
    sq('[data-act="max"]').disabled = !c?.ok;

    const rounds = snap?.rounds ?? [];
    const running = rounds.some((r) => !["scheduled", "done", "failed", "cancelled"].includes(r.state));
    const otherCoin = snap && snap.pageCoin && snap.pageCoin !== snap.settings.coin;
    sq(".sc-go").disabled = !snap || !fits || running || otherCoin;
    sq(".sc-now").disabled = !snap || !fits || running || otherCoin || !!snap.busy;
    renderTrade();
    sq(".sc-list").replaceChildren(...[...rounds].reverse().map((r) => {
      const row = el("div", "sc-item");
      const top = el("div", "sc-item-top");
      const side = r.isLong === undefined ? r.side : r.isLong ? "long" : "short";
      top.append(el("b", null, r.label), el("span", `badge ${STATE_TONE[r.state] ?? ""}`, r.state));
      const when = r.state === "scheduled" ? ` · in ${Math.max(0, Math.round((r.at - now) / 1000))}s` : "";
      const px = (v) => (v == null ? "off" : fmtPx(v));
      const lv = r.entry ? ` · stop ${px(r.stopPx)} / TP ${px(r.limitPx)}` : ` · stop ${levelText(r.stopPct ?? null)} / TP ${levelText(r.limitPct ?? null)}`;
      row.append(top, el("div", "sc-item-d", `${r.coin} paper ${side} $${r.marginUsd} × ${r.ptLeverage}x${lv}${when}`));
      if (r.lastLog) row.append(el("div", "sc-item-log", r.lastLog));
      if (["scheduled", "opening", "hedging", "live"].includes(r.state)) {
        const b = el("button", "pbtn sm", r.state === "scheduled" ? "Cancel" : r.state === "opening" ? "Abort" : "Close now");
        b.dataset.act = "round-cancel";
        b.dataset.id = r.id;
        row.append(b);
      }
      return row;
    }));
  }
  // the open round: what both legs are doing, including papertrade's queue
  function renderTrade() {
    const box = sq(".sg-trade");
    const r = (snap?.rounds ?? []).find((x) => ["opening", "hedging", "live", "closing", "flattening"].includes(x.state));
    box.hidden = !r;
    if (!r) return;
    const side = r.isLong ? "LONG" : "SHORT";
    sq(".sg-trade-t").textContent = `${r.coin} round ${r.label}`;
    sq(".sg-trade-state").textContent = r.state;
    sq(".sg-trade-state").className = `badge sg-trade-state ${r.state === "live" ? "up" : "warn"}`;
    const since = Math.round((Date.now() - (r.openedAt ?? r.stateAt)) / 1000);
    const queued = r.ptQueue
      ? `Papertrade ${r.ptQueue.kind} queued ${Math.round((Date.now() - r.ptQueue.since) / 1000)}s — HL ${r.ptQueue.kind === "open" ? "opens when it fills" : "stays hedged until it fills"}`
      : null;
    sq(".sg-trade-d").textContent = [
      r.entry ? `Paper ${side} $${r.marginUsd} × ${r.ptLeverage}x @ ${fmtPx(r.entry)} · stop ${r.stopPx == null ? "off" : fmtPx(r.stopPx)} · take profit ${r.limitPx == null ? "off" : fmtPx(r.limitPx)} · ${Math.floor(since / 60)}m${String(since % 60).padStart(2, "0")}s` : null,
      queued ?? (r.entry ? null : (r.lastLog ?? "Opening…")),
    ].filter(Boolean).join("\n");
    const pt = snap.pt.summary;
    const h = snap.hl.account;
    sq(".sg-trade-pnl").textContent = pt && h ? `Paper ${signed(pt.uPnlAfterFee)} · HL ${signed(h.uPnl + h.funding)} · net ${signed(pt.uPnlAfterFee + h.uPnl + h.funding)}` : "";
    sq('[data-act="exit"]').disabled = !["opening", "hedging", "live"].includes(r.state);
  }

  setInterval(() => {
    if (!snap) return;
    renderSchedule();
  }, 1000);
  sched.addEventListener("input", () => renderSchedule());

  const q = (s) => card.querySelector(s);
  const ui = Object.fromEntries(
    ["hx-signer", "hx-empty", "hx-main", "hx-pt", "hx-hl", "hx-dtext", "hx-pct", "hx-auto", "hx-ptpnl", "hx-hlpnl", "hx-net-pnl", "hx-bust", "hx-liq", "hx-ptav", "hx-ptq", "hx-hleq", "hx-hlw", "hx-sugg", "hx-amt", "hx-confirm", "hx-confirm-t", "hx-unlock", "hx-pass", "hx-alerts", "hx-levs", "hx-mode", "hx-plan", "hx-netline"].map((c) => [c, q(`.${c}`)]),
  );
  const deltaFill = q(".hx-delta .bar i");
  const hedgeBtn = q('[data-act="hedge"]');

  // ---------- port ----------
  let port = null;
  let snap = null;
  let nextId = 1;
  const waiting = new Map();
  let pendingConfirm = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "wf-pt-hedge" });
    } catch {
      return; // orphaned after an extension reload; content.js reloads the page
    }
    port.onMessage.addListener((msg) => {
      if (msg.kind === "hedge") {
        snap = msg.state;
        render();
      } else if (msg.kind === "result") {
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      } else if (msg.kind === "exec") {
        runExec(msg);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      reportedWallet = undefined; // re-report to the restarted worker
      reportedCoin = undefined;
      snap = null;
      render();
      setTimeout(connect, 2000);
    });
  }
  connect();

  // The account signed in on papertrade (its wagmi wallet session in this page's localStorage),
  // reported to the worker so trades use it without typing the address into settings.
  let reportedWallet;
  function sessionWallet() {
    try {
      const store = JSON.parse(localStorage.getItem("wagmi.store") ?? "null")?.state;
      const conns = store?.connections?.value ?? [];
      const current = conns.find(([id]) => id === store?.current)?.[1];
      const addr = current?.accounts?.[0];
      return /^0x[0-9a-fA-F]{40}$/.test(addr ?? "") ? addr.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  function reportWallet() {
    const addr = sessionWallet();
    if (addr === reportedWallet || !port) return;
    send("setSessionWallet", { address: addr }).then(() => (reportedWallet = addr), () => {});
  }
  setInterval(reportWallet, 3000);
  setTimeout(reportWallet, 500);

  // papertrade is a single-page app: the coin is whatever /trade/<coin> page is showing
  const pageCoin = () => location.pathname.match(/\/trade\/([a-z]+)/i)?.[1]?.toUpperCase() ?? null;
  let reportedCoin;
  function reportCoin() {
    const coin = pageCoin();
    if (!coin || coin === reportedCoin || !port) return;
    send("setPageCoin", { coin }).then(() => (reportedCoin = coin), () => {});
  }
  setInterval(reportCoin, 1000);
  setTimeout(reportCoin, 300);

  function send(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!port) return reject(new Error("Hedge engine not connected"));
      const id = nextId++;
      waiting.set(id, (m) => (m.ok ? resolve(m.data) : reject(new Error(m.error))));
      port.postMessage({ id, cmd, args });
    });
  }

  // ---------- papertrade execution (asked for by the round scheduler in the worker) ----------
  // Papertrade has no API we can sign for (its embedded wallet + session key sign intents), so
  // rounds drive papertrade's own order ticket and Close buttons in this signed-in tab.
  const EXEC = { ptOpen, ptClose };

  async function runExec({ id, action, args }) {
    try {
      const data = await EXEC[action](args);
      port?.postMessage({ kind: "execResult", id, ok: true, data });
    } catch (err) {
      port?.postMessage({ kind: "execResult", id, ok: false, error: String(err.message || err) });
    }
  }

  // Wait for papertrade's React UI to reflect a change. A MutationObserver fires on the DOM commit
  // itself; requestAnimationFrame stops in hidden tabs, which used to stall orders for seconds.
  function settle(check, timeoutMs = 400) {
    return new Promise((resolve) => {
      if (check()) return resolve(true);
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(check());
      }, timeoutMs);
      const obs = new MutationObserver(() => {
        if (!check()) return;
        obs.disconnect();
        clearTimeout(timer);
        resolve(true);
      });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  // React tracks input values; the native setter + an input event is what a keystroke does
  function setReactInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function tradeButton() {
    return [...document.querySelectorAll("button")].find((b) => /^Place Trade/.test(b.textContent.trim()));
  }

  async function ptOpen({ coin, isLong, marginUsd, leverage }) {
    const startMs = Date.now();
    if (!location.pathname.toLowerCase().includes(`/trade/${coin.toLowerCase()}`)) throw new Error(`Not on papertrade's ${coin} trade page`);
    const sideBtn = document.querySelector(isLong ? "button.dup" : "button.ddn");
    const im = document.getElementById("im");
    const il = document.getElementById("il");
    if (!sideBtn || !im || !il) throw new Error("Papertrade order ticket not found");
    if (sideBtn.getAttribute("aria-pressed") !== "true") sideBtn.click();
    // the ticket keeps margin and leverage between trades: rewriting unchanged values only costs a render
    if (Number(im.value) !== marginUsd) setReactInput(im, marginUsd);
    if (Number(il.value) !== leverage) setReactInput(il, leverage);
    await settle(() => sideBtn.getAttribute("aria-pressed") === "true" && Number(im.value) === marginUsd && Number(il.value) === leverage && tradeButton()?.disabled === false);
    if (sideBtn.getAttribute("aria-pressed") !== "true") throw new Error("Couldn't select the side on papertrade's ticket");
    if (Number(im.value) !== marginUsd || Number(il.value) !== leverage) throw new Error(`Ticket shows $${im.value} × ${il.value}x, expected $${marginUsd} × ${leverage}x`);
    const place = tradeButton();
    if (!place) {
      const hint = [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).find((t) => /Authenticate|Connect|Enable|Read-only|Switch/.test(t));
      throw new Error(`Papertrade isn't ready to trade${hint ? ` (shows "${hint}")` : ""}`);
    }
    if (place.disabled) throw new Error("Place Trade is disabled on papertrade (balance, minimum size or trading paused)");
    place.click();
    return { clicked: true, startMs, clickMs: Date.now(), hidden: document.hidden };
  }

  async function ptClose({ positionId }) {
    const sel = `button[aria-label$=" position ${positionId}"]`;
    let btn = document.querySelector(sel);
    if (!btn) {
      // the Close buttons live on the Positions tab
      [...document.querySelectorAll("button, a")].find((b) => /^Positions/.test(b.textContent.trim()))?.click();
      await settle(() => !!document.querySelector(sel));
      btn = document.querySelector(sel);
    }
    if (!btn) throw new Error(`Close button for papertrade position ${positionId} not found`);
    if (btn.disabled) return { pending: btn.textContent.trim() }; // Pending… / Queued… / Confirming…
    btn.click();
    return { clicked: true, clickMs: Date.now(), hidden: document.hidden };
  }

  function flash(level, text) {
    const a = el("div", `hx-alert ${level}`, text);
    ui["hx-alerts"].prepend(a);
    setTimeout(() => a.remove(), 8000);
  }

  // ---------- render ----------
  // While Paper Route is responsible for positions: a banner at the top of the HUD, and a "Leave
  // site?" prompt if the papertrade tab is closed or reloaded.
  const banner = el("div", "pr-banner");
  banner.hidden = true;
  hud.body.prepend(banner);
  let managing = false;
  function syncManaging() {
    managing = !!snap?.managing;
    banner.hidden = !managing;
    if (!managing) return;
    const r = (snap.rounds ?? []).find((x) => !["done", "failed", "cancelled"].includes(x.state));
    banner.textContent = r
      ? r.state === "scheduled"
        ? `A round is scheduled for ${r.label}. Keep Chrome open and Paper Route enabled until it has run and closed.`
        : "Paper Route is managing your exits. Keep Chrome open and Paper Route enabled until both legs close."
      : "Tether is holding a hedged position. Keep Chrome open and Paper Route enabled while it's open.";
  }
  window.addEventListener("beforeunload", (e) => {
    if (!managing) return;
    e.preventDefault();
    e.returnValue = ""; // Chrome shows its own "Leave site?" text
  });

  // chart lines: the open round's entry / stop / take profit, papertrade's bust and HL's liquidation
  function syncLevels() {
    const levels = [];
    const r = (snap?.rounds ?? []).find((x) => ["hedging", "live", "closing"].includes(x.state) && x.entry);
    if (r) {
      levels.push({ price: r.entry, label: `Entry ${r.isLong ? "long" : "short"}`, kind: "entry" });
      if (r.stopPx != null) levels.push({ price: r.stopPx, label: `Stop ${r.stopPct}%`, kind: "stop" });
      if (r.limitPx != null) levels.push({ price: r.limitPx, label: `Take profit ${r.limitPct}%`, kind: "limit" });
    }
    if (snap && !snap.lockedBy) {
      if (snap.pt.summary?.bust) levels.push({ price: snap.pt.summary.bust, label: "Paper bust", kind: "bust" });
      if (snap.hl.account?.liqPx) levels.push({ price: snap.hl.account.liqPx, label: "HL liq", kind: "liq" });
    }
    hud.setLevels(levels);
  }

  function render() {
    syncLevels();
    syncManaging();
    if (!snap) {
      ui["hx-main"].hidden = true;
      ui["hx-empty"].hidden = false;
      ui["hx-empty"].textContent = port ? "Waiting for hedge engine…" : "Hedge engine not loaded — rebuild the extension (npm run build).";
      ui["hx-signer"].textContent = "—";
      return;
    }
    renderSchedule();
    renderLeverage();
    const s = snap;
    const v = s.vault;
    // the agent (trading key) works on its own; the main key is only needed for transfers
    const agentOk = !!v.agent && v.agent.hedgeWallet === s.settings.hedgeWallet.toLowerCase() && v.agent.network === s.settings.network;
    const canTrade = agentOk || v.unlocked;
    ui["hx-signer"].textContent = agentOk ? "Trading key" : v.unlocked ? (v.mode === "wayfinder" ? "Wayfinder" : "Main key") : v.remembered ? "Locked" : "No key";
    ui["hx-signer"].className = `badge hx-signer ${canTrade ? "up" : "warn"}`;
    ui["hx-unlock"].hidden = v.unlocked || !v.remembered;

    if (s.lockedBy) {
      ui["hx-main"].hidden = true;
      ui["hx-empty"].hidden = false;
      ui["hx-empty"].textContent = `Still managing ${s.settings.coin} (${s.lockedBy === "round" ? "a round is running" : "tether is holding an open position"}) — open the ${s.settings.coin} page to see it. ${s.pageCoin} takes over once it's flat.`;
      return;
    }
    if (!s.settings.ptWallet || !s.settings.hedgeWallet) {
      ui["hx-main"].hidden = true;
      ui["hx-empty"].hidden = false;
      ui["hx-empty"].textContent = "Add your papertrade and hedge wallets in settings (toolbar icon).";
      return;
    }
    ui["hx-empty"].hidden = !(s.pt.status !== "live" || s.hl.status !== "live");
    ui["hx-empty"].textContent = `Papertrade ${s.pt.status}${s.pt.error ? ` (${s.pt.error})` : ""} · Hyperliquid ${s.hl.status}${s.hl.error ? ` (${s.hl.error})` : ""}`;
    ui["hx-main"].hidden = !s.pt.summary || !s.hl.account;
    if (ui["hx-main"].hidden) return;

    const pt = s.pt.summary;
    const h = s.hl.account;
    const coin = s.settings.coin;
    ui["hx-pt"].textContent = pt.netSize === 0 ? "Flat" : `${pt.netSize > 0 ? "Long" : "Short"} ${qty(pt.netSize)} ${coin} · ${usdK(Math.abs(pt.netSize) * h.mid)}`;
    ui["hx-pt"].className = `hx-pt ${tone(pt.netSize)}`;
    ui["hx-hl"].textContent = h.size === 0 ? "Flat" : `${h.size > 0 ? "Long" : "Short"} ${qty(h.size)} ${coin} · ${usdK(Math.abs(h.size) * h.mid)}`;
    ui["hx-hl"].className = `hx-hl ${tone(h.size)}`;

    const d = s.delta;
    const gross = Math.abs(pt.netSize) * h.mid;
    const hedged = gross === 0 ? (h.size === 0 ? 100 : 0) : Math.max(0, 100 - (Math.abs(d.deltaUsd) / gross) * 100);
    ui["hx-dtext"].textContent = `Δ ${signed(d.deltaUsd, 0)} ${Math.abs(d.deltaUsd) <= s.settings.bandUsd ? "· in band" : ""}`;
    ui["hx-pct"].textContent = `${hedged.toFixed(1)}% hedged`;
    ui["hx-pct"].className = `hx-pct ${hedged >= 99 ? "up" : hedged >= 90 ? "" : "dn"}`;
    const scale = Math.max(s.settings.bandUsd * 4, 1);
    deltaFill.className = d.deltaUsd >= 0 ? "up" : "dn";
    deltaFill.style.transform = `scaleX(${Math.min(1, Math.abs(d.deltaUsd) / scale)})`;

    hedgeBtn.disabled = !!s.busy || !canTrade || Math.abs(d.deltaUsd) < 10;
    hedgeBtn.textContent = s.busy ?? "Hedge to 100%";
    ui["hx-auto"].checked = s.auto;
    ui["hx-auto"].disabled = !canTrade;
    ui["hx-auto"].parentElement.querySelector("em").textContent = `Tether · ±$${s.settings.bandUsd}`;

    renderPlan();

    const net = pt.uPnlAfterFee + h.uPnl + h.funding;
    setNum(ui["hx-ptpnl"], pt.uPnlAfterFee, s.winFeeRate ? ` after ${(s.winFeeRate * 100).toFixed(0)}% win fee` : "");
    setNum(ui["hx-hlpnl"], h.uPnl + h.funding, h.funding ? ` incl. ${signed(h.funding)} funding` : "");
    setNum(ui["hx-net-pnl"], net, "");
    ui["hx-bust"].textContent = pt.bust ? `${fmtPx(pt.bust)} · ${(s.ptBustDist * 100).toFixed(2)}%` : "—";
    const buffer = s.hlLiqDist && s.ptBustDist ? s.hlLiqDist / s.ptBustDist : null;
    ui["hx-liq"].textContent = h.liqPx ? `${fmtPx(h.liqPx)} · ${(s.hlLiqDist * 100).toFixed(2)}%${buffer ? ` · ${buffer.toFixed(1)}× bust` : ""}` : "—";
    ui["hx-liq"].className = `hx-liq ${buffer !== null && buffer < s.settings.marginK ? "dn" : ""}`;
    renderSafetyNet();

    ui["hx-ptav"].textContent = usd(pt.available);
    ui["hx-ptq"].textContent = pt.queued > 0 ? `${usd(pt.queued)} queued` : "";
    ui["hx-hleq"].textContent = usd(h.accountValue + (s.hl.abstraction === "default" ? h.spotUsdc : 0));
    // margin HL will still let us use for a new hedge (per side; the hedge side is what matters)
    const hedgeIdx = pt.netSize > 0 ? 1 : pt.netSize < 0 ? 0 : null;
    const free = hedgeIdx === null ? Math.min(...h.availableToTrade) : h.availableToTrade[hedgeIdx];
    ui["hx-hlw"].textContent = `${usd(free)} free to trade · ${usd(h.withdrawable)} withdrawable`;

    const sg = s.suggestion;
    ui["hx-sugg"].textContent = !sg
      ? "—"
      : sg.direction === "toPapertrade"
        ? `Suggest moving $${sg.amount} → papertrade (HL keeps ${usd(sg.hlRequired, 0)} for a ${s.settings.marginK}× buffer)`
        : sg.direction === "toHyperliquid"
          ? `HL is $${Math.ceil(-sg.hlExcess)} short of a ${s.settings.marginK}× buffer — move $${sg.amount} → Hyperliquid`
          : "Balances are on target";
    if (sg?.direction && !ui["hx-amt"].value) ui["hx-amt"].placeholder = String(sg.amount);
    for (const b of card.querySelectorAll('[data-act="toPt"], [data-act="toHl"]')) b.disabled = !!s.busy;

    renderAlerts();
  }

  const LEVERAGES = [3, 5, 10, 20, 40];

  function renderLeverage() {
    const max = snap.maxLeverage ?? 40;
    const options = LEVERAGES.filter((l) => l <= max);
    const key = options.join(",");
    if (ui["hx-levs"].dataset.key !== key) {
      ui["hx-levs"].dataset.key = key;
      ui["hx-levs"].replaceChildren(...options.map((l) => {
        const b = el("button", null, `${l}x`);
        b.dataset.act = "lev";
        b.dataset.lev = String(l);
        return b;
      }));
    }
    // picking works before setup too: it's saved, and applied on HL before the first hedge order
    const applied = snap.hl.account?.leverage;
    for (const b of ui["hx-levs"].children) {
      const l = Number(b.dataset.lev);
      b.classList.toggle("on", l === snap.settings.hlLeverage);
      b.classList.toggle("applied", l === applied?.value);
      b.disabled = !!snap.busy;
    }
    for (const b of ui["hx-mode"].children) {
      b.classList.toggle("on", (b.dataset.cross === "1") === snap.settings.hlCross);
      b.disabled = !!snap.busy;
    }
  }

  // Papertrade's order ticket: margin (#im), leverage (#il), side toggle (aria-pressed)
  function readTicket() {
    const margin = Number(document.getElementById("im")?.value);
    const leverage = Number(document.getElementById("il")?.value);
    const longBtn = document.querySelector("button.dup");
    if (!(margin > 0) || !(leverage > 0) || !longBtn) return null;
    return { margin, leverage, isLong: longBtn.getAttribute("aria-pressed") === "true" };
  }

  // What the hedge will be: from the open papertrade position, or from the ticket before opening
  function renderPlan() {
    const pt = snap.pt.summary;
    const h = snap.hl.account;
    const coin = snap.settings.coin;
    const lev = snap.settings.hlLeverage;
    let paperLong;
    let notional;
    let source;
    if (pt.netSize !== 0) {
      paperLong = pt.netSize > 0;
      notional = Math.abs(pt.netSize) * h.mid;
      source = "Open position";
    } else {
      const t = readTicket();
      if (!t) {
        ui["hx-plan"].textContent = "";
        return;
      }
      paperLong = t.isLong;
      notional = t.margin * t.leverage;
      source = `Ticket ${usd(t.margin, 0)} × ${t.leverage}x`;
    }
    const size = notional / h.mid;
    ui["hx-plan"].replaceChildren(
      el("span", "lbl", source),
      el("span", "hx-plan-v", `Paper ${paperLong ? "long" : "short"} ${usdK(notional)} → HL ${paperLong ? "short" : "long"} ${qty(size)} ${coin} · ${usdK(notional / lev)} margin at ${lev}x`),
    );
  }

  function renderSafetyNet() {
    const n = snap.safetyNet;
    const box = ui["hx-netline"];
    const hedged = snap.pt.summary.netSize !== 0 && snap.hl.account.size !== 0;
    box.hidden = !hedged && !n.orders.length && !n.error;
    if (!snap.settings.safetyNet) {
      box.textContent = "Safety net off (settings): if papertrade busts while Chrome is closed, the hedge stays open";
      box.className = "hx-netline warn";
    } else if (n.error) {
      box.textContent = `Safety net not placed: ${n.error}`;
      box.className = "hx-netline dn";
    } else if (n.orders.length) {
      box.textContent = `Safety net on Hyperliquid: closes ${n.orders.map((o) => `${o.sz} at ${fmtPx(o.triggerPx)}`).join(", ")} (papertrade liquidation)`;
      box.className = "hx-netline up";
    } else {
      box.textContent = hedged ? "Safety net: placing…" : "";
      box.className = "hx-netline";
    }
  }

  function setNum(node, value, suffix) {
    node.textContent = `${signed(value)}${suffix}`;
    node.className = `${node.className.split(" ")[0]} ${tone(value)}`;
  }

  let alertKey = "";
  function renderAlerts() {
    const key = snap.alerts.map((a) => a.at).join(",");
    if (key === alertKey) return;
    alertKey = key;
    const box = ui["hx-alerts"];
    for (const n of box.querySelectorAll(".hx-alert.engine")) n.remove();
    for (const a of snap.alerts.slice(0, 2)) box.append(el("div", `hx-alert engine ${a.level}`, a.text));
  }

  document.addEventListener("input", (e) => {
    if ((e.target.id === "im" || e.target.id === "il") && snap?.pt.summary && snap.hl.account) renderPlan();
  }, true);

  // ---------- actions ----------
  function confirm(text, run) {
    pendingConfirm = run;
    ui["hx-confirm-t"].textContent = text;
    ui["hx-confirm"].hidden = false;
  }

  function hedgePreview() {
    const d = snap.delta;
    const sz = Math.abs(d.delta);
    const fee = sz * d.mid * (0.00045 + (snap.settings.builderFee ? 0.0002 : 0));
    const lev = snap.settings.hlLeverage;
    return `${d.delta > 0 ? "Buy" : "Sell"} ${qty(sz)} ${snap.settings.coin} on Hyperliquid ≈ ${usd(sz * d.mid, 0)} at ${lev}x ${snap.settings.hlCross ? "cross" : "isolated"} · fees ~${usd(fee)}`;
  }

  card.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    try {
      if (act === "toggle") card.classList.toggle("collapsed");
      else if (act === "hedge") confirm(hedgePreview(), () => send("hedgeNow"));
      else if (act === "lev" || act === "mode") {
        const btn = e.target.closest("[data-act]");
        const leverage = act === "lev" ? Number(btn.dataset.lev) : snap.settings.hlLeverage;
        const cross = act === "mode" ? btn.dataset.cross === "1" : snap.settings.hlCross;
        const live = (snap.vault.unlocked || snap.vault.agent) && snap.hl.account;
        confirm(
          live
            ? `Set ${snap.settings.coin} leverage on Hyperliquid to ${leverage}x ${cross ? "cross" : "isolated"}`
            : `Save ${leverage}x ${cross ? "cross" : "isolated"} — applied on Hyperliquid before the first hedge order`,
          () => send("setLeverage", { leverage, cross }),
        );
      }
      else if (act === "toPt") {
        const amount = Number(ui["hx-amt"].value || ui["hx-amt"].placeholder);
        if (!(amount > 0)) throw new Error("Enter an amount");
        confirm(`Send $${amount} USDC from ${short(snap.settings.hedgeWallet)} to papertrade ${short(snap.settings.ptWallet)}`, () => send("sendToPapertrade", { amount }));
      } else if (act === "toHl") openPapertradeWithdraw();
      else if (act === "confirm") {
        const run = pendingConfirm;
        pendingConfirm = null;
        ui["hx-confirm"].hidden = true;
        await run();
        flash("ok", "Done");
      } else if (act === "cancel") {
        pendingConfirm = null;
        ui["hx-confirm"].hidden = true;
      } else if (act === "unlock") {
        await send("unlock", { passphrase: ui["hx-pass"].value, hours: 8 });
        ui["hx-pass"].value = "";
      }
    } catch (err) {
      flash("error", String(err.message || err));
    }
  });

  ui["hx-auto"].addEventListener("change", async (e) => {
    try {
      await send("setAuto", { on: e.target.checked });
    } catch (err) {
      e.target.checked = false;
      flash("error", String(err.message || err));
    }
  });

  // Papertrade → HL: papertrade's embedded wallet signs its own withdrawals, so we only open
  // its Withdraw dialog. The user finishes (and confirms) inside papertrade.
  function openPapertradeWithdraw() {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Withdraw");
    if (!btn) throw new Error("Couldn't find papertrade's Withdraw button");
    btn.click();
    const amount = ui["hx-amt"].value || ui["hx-amt"].placeholder;
    flash("warn", `Withdraw $${amount} in papertrade, then send it from ${short(snap.settings.ptWallet)} to the hedge wallet ${short(snap.settings.hedgeWallet)}`);
  }

  render();
})();
