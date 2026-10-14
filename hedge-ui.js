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
      <span class="cap" data-tip="Tether links your papertrade position to an opposite position on Hyperliquid, so price moves cancel out. Click to collapse this section.">Tether ⓘ</span>
      <span class="hx-chips"><span class="badge hx-status">—</span><span class="badge hx-signer">—</span></span>
    </div>
    <div class="hx-body">
      <div class="hx-status-t"></div>
      <div class="hx-confirm" hidden>
        <span class="hx-confirm-t"></span>
        <input class="field hx-xkey" type="password" autocomplete="off" spellcheck="false" hidden placeholder="Paste your Hyperliquid key to sign this transfer" data-tip="Transfers need your wallet's own key (the trading key can't move funds). It's used for this transfer only and not saved." />
        <div><button class="pbtn primary" data-act="confirm">Confirm</button><button class="pbtn" data-act="cancel">Cancel</button></div>
      </div>
      <button class="pbtn primary hx-tether-on" data-act="tether-on" hidden data-tip="Hyperliquid will follow every papertrade position on this coin: it opens and closes the opposite side when papertrade's orders fill.">Turn on Tether</button>
      <div class="hx-lev">
        <span class="lbl" data-tip="Leverage for the Hyperliquid hedge. Higher leverage needs less margin but puts Hyperliquid's liquidation closer. Applied on Hyperliquid before the next hedge order.">HL leverage</span>
        <div class="seg hx-levs"></div>
        <div class="seg hx-mode"><button data-act="mode" data-cross="1" data-tip="Cross margin: the hedge can use all free USDC in your Hyperliquid account. Liquidation is further away.">Cross</button><button data-act="mode" data-cross="0" data-tip="Isolated margin: only the margin put on this position can be lost. Liquidation is closer.">Iso</button></div>
      </div>
      <div class="hx-empty"></div>
      <div class="hx-main">
        <div class="hx-legs">
          <div class="hx-leg" data-tip="Your filled papertrade position on this coin (queued orders don't count until they fill)"><span class="lbl">Papertrade</span><span class="hx-pt">—</span></div>
          <div class="hx-leg" data-tip="Your Hyperliquid position on this coin. When hedged it's the same size, opposite side."><span class="lbl">Hyperliquid</span><span class="hx-hl">—</span></div>
        </div>
        <div class="hx-delta" data-tip="How far the two legs are from cancelling out, in dollars. Within your band, Tether leaves it alone; outside, it trades Hyperliquid to close the gap.">
          <div class="bar wide"><i></i></div>
          <div class="hx-delta-t"><span class="hx-dtext">—</span><span class="hx-pct">—</span></div>
        </div>
        <div class="hx-plan"></div>
        <div class="hx-actions">
          <button class="pbtn primary" data-act="hedge" data-tip="One-off: trade Hyperliquid now so it exactly offsets your papertrade position. Asks you to confirm first.">Hedge to 100%</button>
          <label class="switch" data-tip="Tether on: Hyperliquid follows papertrade automatically. When a papertrade open or close fills (after papertrade's queue), Hyperliquid opens or closes the opposite side."><input type="checkbox" class="hx-auto" /><span></span><em>Tether</em></label>
        </div>
        <div class="hx-grid">
          <span class="lbl" data-tip="Papertrade profit or loss if you closed now, after papertrade's fee on wins">Paper P&amp;L</span><span class="hx-ptpnl">—</span>
          <span class="lbl" data-tip="Hyperliquid profit or loss on the hedge, including funding paid or received">HL P&amp;L</span><span class="hx-hlpnl">—</span>
          <span class="lbl" data-tip="Both legs together. When fully hedged this stays near zero apart from fees, funding and papertrade's win fee.">Net</span><span class="hx-net-pnl">—</span>
          <span class="lbl" data-tip="Price at which papertrade liquidates your position (you lose that margin), and how far away it is">Paper bust</span><span class="hx-bust">—</span>
          <span class="lbl" data-tip="Price at which Hyperliquid would liquidate the hedge. It should be further away than papertrade's bust. Red means it's too close for your buffer setting.">HL liq</span><span class="hx-liq">—</span>
        </div>
        <div class="hx-netline" data-tip="Safety net: orders resting on Hyperliquid at papertrade's liquidation prices. If papertrade busts while this browser is closed, the hedge closes with it at the same price."></div>
        <details class="hx-accts">
          <summary data-tip="Balances on both venues, moving USDC between them, and every position on your Hyperliquid account"><span class="lbl">Accounts &amp; transfers</span><span class="hx-accts-sum"></span><span class="hx-chev">›</span></summary>
          <div class="hx-accts-b">
        <div class="hx-bal">
          <div data-tip="USDC in papertrade that's free for new positions"><span class="lbl">Paper avail.</span><b class="hx-ptav">—</b><small class="hx-ptq"></small></div>
          <div data-tip="Your Hyperliquid account value, and how much is free for more hedging or can be withdrawn"><span class="lbl">HL equity</span><b class="hx-hleq">—</b><small class="hx-hlw"></small></div>
        </div>
        <div class="hx-rebal">
          <span class="hx-sugg" data-tip="Keeps Hyperliquid's liquidation a safe multiple further away than papertrade's bust, and enough USDC on papertrade for your next trade">—</span>
          <div class="hx-rebal-row">
            <input class="field hx-amt" type="number" min="1" step="1" placeholder="USDC" data-tip="Amount of USDC to move" />
            <button class="pbtn" data-act="toPt" data-tip="Send USDC from your Hyperliquid account to your papertrade deposit address. You'll paste your key to sign it; it isn't saved.">→ Papertrade</button>
            <button class="pbtn" data-act="toHl" data-tip="Opens papertrade's own Withdraw dialog. Papertrade's wallet signs its withdrawals, so you finish it there.">→ Hyperliquid</button>
          </div>
        </div>
        <div class="hx-acct-slot"></div>
          </div>
        </details>
      </div>
      <div class="hx-unlock" hidden>
        <input class="field hx-pass" type="password" placeholder="Main key passphrase (for transfers)" autocomplete="off" data-tip="Your main key is only needed to move USDC and for one-time approvals. Hedging uses the trading key." />
        <button class="pbtn" data-act="unlock">Unlock</button>
      </div>
      <div class="hx-alerts"></div>
    </div>`;
  hud.body.append(card);

  // ---------- Hyperliquid positions, inside "Accounts & transfers" ----------
  const acct = el("div", "hlacct");
  acct.innerHTML = `
    <div class="hla-title"><span class="lbl" data-tip="Every open perp position on your Hyperliquid wallet, on all coins">Hyperliquid positions</span><span class="hla-addr" data-tip="Your connected Hyperliquid wallet"></span></div>
    <div class="hla-pos"></div>
    <div class="hla-spot"></div>`;
  card.querySelector(".hx-acct-slot").append(acct);
  const aq = (sel) => acct.querySelector(sel);
  const accts = card.querySelector(".hx-accts");
  chrome.storage.local.get("acctsOpen").then(({ acctsOpen }) => (accts.open = !!acctsOpen));
  accts.addEventListener("toggle", () => chrome.storage.local.set({ acctsOpen: accts.open }));

  const fmtSz = (v) => Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 5 });
  const fmtPrice = (v) => (v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 1 : 4 }));

  function renderAccount() {
    const h = snap?.hl.account;
    acct.hidden = !snap?.settings.hedgeWallet;
    if (acct.hidden) return;
    aq(".hla-addr").textContent = short(snap.settings.hedgeWallet);
    if (!h) {
      aq(".hla-pos").replaceChildren(el("div", "hla-empty", snap.hl.status === "down" ? `Can't read Hyperliquid: ${snap.hl.error}` : "Loading Hyperliquid account…"));
      return;
    }
    const pt = snap.pt.summary;
    card.querySelector(".hx-accts-sum").textContent = `${pt ? `${usdK(pt.available)} papertrade · ` : ""}${Number.isFinite(h.equity) ? usdK(h.equity) : "—"} Hyperliquid`;

    const coin = snap.settings.coin;
    const head = el("div", "hla-row hla-head");
    for (const [t, tipText] of [
      ["Position", "Coin, side and size"],
      ["Entry → mark", "Average entry price, and the current mid"],
      ["P&L", "Unrealized profit or loss, and return on the margin used"],
      ["Liq.", "Hyperliquid liquidation price"],
    ]) {
      const c = el("span", null, t);
      c.dataset.tip = tipText;
      head.append(c);
    }
    const MAX_ROWS = 8;
    const sorted = [...h.positions].sort((x, y) => (y.coin === coin) - (x.coin === coin) || Math.abs(y.value) - Math.abs(x.value));
    const rows = sorted.slice(0, MAX_ROWS).map((p) => {
      const row = el("div", `hla-row${p.coin === coin ? " here" : ""}`);
      const side = p.size > 0 ? "Long" : "Short";
      const name = el("span", "hla-coin");
      name.append(el("b", null, p.coin), el("span", `hla-side ${p.size > 0 ? "up" : "dn"}`, ` ${side} ${fmtSz(p.size)}`));
      name.dataset.tip = `${p.coin} ${side.toLowerCase()} ${fmtSz(p.size)} · ${usd(p.value, 0)} notional · ${p.leverage.value}x ${p.leverage.isCross ? "cross" : "isolated"} · ${usd(p.margin)} margin${p.coin === coin ? " · this is the coin you're viewing on papertrade" : ""}`;
      const px = el("span", "hla-px", `${fmtPrice(p.entry)} → ${fmtPrice(p.mark)}`);
      const pnl = el("span", `hla-pnl ${p.uPnl >= 0 ? "up" : "dn"}`, `${signed(p.uPnl)} (${(p.roe * 100).toFixed(1)}%)`);
      pnl.dataset.tip = `Unrealized ${signed(p.uPnl)}; funding since open ${signed(p.funding)}`;
      const liq = el("span", "hla-liq", fmtPrice(p.liqPx));
      if (p.liqPx && p.mark) liq.dataset.tip = `${((Math.abs(p.liqPx / p.mark - 1)) * 100).toFixed(2)}% from the current price`;
      row.append(name, px, pnl, liq);
      return row;
    });
    if (sorted.length > MAX_ROWS) rows.push(el("div", "hla-empty", `+${sorted.length - MAX_ROWS} more positions (largest shown)`));
    aq(".hla-pos").replaceChildren(...(rows.length ? [head, ...rows] : [el("div", "hla-empty", "No open positions on Hyperliquid.")]));

    const others = h.spot.filter((b) => b.coin !== "USDC");
    aq(".hla-spot").textContent = others.length
      ? `Spot: ${others.map((b) => `${fmtSz(b.total)} ${b.coin}${Number.isFinite(b.usd) ? ` (${usd(b.usd, 0)})` : ""}`).join(" · ")}`
      : "";
  }

  const q = (s) => card.querySelector(s);
  const ui = Object.fromEntries(
    ["hx-signer", "hx-empty", "hx-main", "hx-pt", "hx-hl", "hx-dtext", "hx-pct", "hx-auto", "hx-ptpnl", "hx-hlpnl", "hx-net-pnl", "hx-bust", "hx-liq", "hx-ptav", "hx-ptq", "hx-hleq", "hx-hlw", "hx-sugg", "hx-amt", "hx-confirm", "hx-confirm-t", "hx-unlock", "hx-pass", "hx-alerts", "hx-levs", "hx-mode", "hx-plan", "hx-netline", "hx-status", "hx-status-t", "hx-xkey", "hx-tether-on"].map((c) => [c, q(`.${c}`)]),
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
        for (const fn of snapListeners) fn(snap);
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

  // shared with tpsl-ui.js (same isolated world): engine snapshots and commands
  const snapListeners = [];
  window.__wfHedge = { send: (cmd, args) => send(cmd, args), snap: () => snap, onSnap: (fn) => snapListeners.push(fn) };

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
    // exactly the Close button: each row also has "Details for BTC position <id>", which comes first
    const sel = `button[aria-label^="Close "][aria-label$=" position ${positionId}"]`;
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
        ? `A hedged trade is scheduled for ${r.label}. Keep Chrome open and Paper Route enabled until it has run and closed.`
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
    for (const [id, x] of Object.entries(snap?.exits?.byPosition ?? {})) {
      if (x.coin !== snap.settings.coin) continue;
      const tag = Object.keys(snap.exits.byPosition).length > 1 ? ` #${id.slice(-4)}` : "";
      if (x.tpPx != null) levels.push({ price: x.tpPx, label: `Take profit${tag}`, kind: "limit" });
      if (x.slPx != null) levels.push({ price: x.slPx, label: `Stop loss${tag}`, kind: "stop" });
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
    renderAccount();
    if (!snap) {
      ui["hx-main"].hidden = true;
      ui["hx-empty"].hidden = false;
      ui["hx-empty"].textContent = port ? "Waiting for hedge engine…" : "Hedge engine not loaded — rebuild the extension (npm run build).";
      ui["hx-signer"].textContent = "—";
      setStatus("Offline", "", "The extension's background worker isn't connected. Reload papertrade.");
      return;
    }
    renderLeverage();
    const s = snap;
    const v = s.vault;
    // the agent (trading key) works on its own; the main key is only needed for transfers
    const agentOk = !!v.agent && v.agent.hedgeWallet === s.settings.hedgeWallet.toLowerCase() && v.agent.network === s.settings.network;
    const canTrade = agentOk || v.unlocked;
    ui["hx-signer"].textContent = agentOk ? "Connected" : v.unlocked ? (v.mode === "wayfinder" ? "Wayfinder key" : "Your key") : v.remembered ? "Locked" : "No key";
    ui["hx-signer"].className = "badge hx-signer";
    // the status pill already says "Not set up" / "Needs key"; the signer badge only adds which key is in use
    ui["hx-signer"].hidden = !canTrade || !s.settings.hedgeWallet;
    ui["hx-signer"].dataset.tip = agentOk
      ? "Hedge orders are signed by Paper Route's trading key on your Hyperliquid account: it can trade but can't withdraw."
      : v.unlocked
        ? "Hedge orders are signed by your saved key. Connect in settings to switch to a trading key, so your key needn't stay unlocked."
        : "Not connected. Click the Paper Route toolbar icon, paste your key and click Connect.";
    ui["hx-unlock"].hidden = v.unlocked || !v.remembered;
    renderTetherStatus(s, canTrade);

    if (s.lockedBy) {
      ui["hx-main"].hidden = true;
      ui["hx-empty"].hidden = false;
      ui["hx-empty"].textContent = `Still managing ${s.settings.coin} (${s.lockedBy === "round" ? "a hedged trade is running" : "Tether is holding an open position"}) — open the ${s.settings.coin} page to see it. ${s.pageCoin} takes over once it's flat.`;
      return;
    }
    if (!s.settings.ptWallet || !s.settings.hedgeWallet) {
      ui["hx-main"].hidden = true;
      ui["hx-empty"].hidden = true; // the status line says what to do
      return;
    }
    // the status line covers "connecting"; this only adds the error detail when there is one
    ui["hx-empty"].hidden = !(s.pt.error || s.hl.error);
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
    const off = Math.abs(d.deltaUsd);
    ui["hx-dtext"].textContent = off < 1 ? "Legs match" : `Off by ${usd(off, 0)} · ${off <= s.settings.bandUsd ? "within" : "outside"} your ±$${s.settings.bandUsd} band`;
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
    setNum(ui["hx-ptpnl"], pt.uPnlAfterFee, "");
    setNum(ui["hx-hlpnl"], h.uPnl + h.funding, h.funding ? ` incl. ${signed(h.funding)} funding` : "");
    setNum(ui["hx-net-pnl"], net, "");
    ui["hx-bust"].textContent = pt.bust ? `${fmtPx(pt.bust)} · ${(s.ptBustDist * 100).toFixed(2)}%` : "—";
    const buffer = s.hlLiqDist && s.ptBustDist ? s.hlLiqDist / s.ptBustDist : null;
    ui["hx-liq"].textContent = h.liqPx ? `${fmtPx(h.liqPx)} · ${(s.hlLiqDist * 100).toFixed(2)}%${buffer ? ` · ${buffer.toFixed(1)}× bust` : ""}` : "—";
    ui["hx-liq"].className = `hx-liq ${buffer !== null && buffer < s.settings.marginK ? "dn" : ""}`;
    renderSafetyNet();

    ui["hx-ptav"].textContent = usd(pt.available);
    ui["hx-ptq"].textContent = pt.queued > 0 ? `${usd(pt.queued)} queued` : "";
    ui["hx-hleq"].textContent = Number.isFinite(h.equity) ? usd(h.equity) : "—";
    // margin HL will still let us use for a new hedge (per side; the hedge side is what matters)
    const hedgeIdx = pt.netSize > 0 ? 1 : pt.netSize < 0 ? 0 : null;
    const free = hedgeIdx === null ? Math.min(...h.availableToTrade) : h.availableToTrade[hedgeIdx];
    ui["hx-hlw"].textContent = `${usd(free)} free to trade · ${usd(h.outable ?? h.withdrawable)} withdrawable`;

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

  // ---------- tether status: one word in the header, one sentence under it ----------
  function setStatus(label, tone, text, offerTether = false) {
    ui["hx-tether-on"].hidden = !offerTether;
    ui["hx-status"].textContent = label;
    ui["hx-status"].className = `badge hx-status ${tone}`;
    ui["hx-status"].dataset.tip = text;
    ui["hx-status-t"].textContent = text;
    ui["hx-status-t"].className = `hx-status-t ${tone}`;
  }

  const STOPPED_SHOWN_MS = 10 * 60_000;

  function renderTetherStatus(s, canTrade) {
    const pt = s.pt.summary;
    const h = s.hl.account;
    const band = s.settings.bandUsd;
    if (!s.settings.ptWallet || !s.settings.hedgeWallet) {
      return setStatus("Not connected", "", "Connect your Hyperliquid wallet: click the Paper Route toolbar icon, paste your key, click Connect.");
    }
    if (!canTrade) {
      return setStatus("Not connected", "warn", "Connect your Hyperliquid wallet again in settings (click the Paper Route toolbar icon) so Paper Route can place hedge orders on Hyperliquid.");
    }
    if (s.auto && (s.pt.status !== "live" || s.hl.status !== "live")) {
      const which = [s.pt.status !== "live" && "papertrade", s.hl.status !== "live" && "Hyperliquid"].filter(Boolean).join(" and ");
      return setStatus("Reconnecting", "warn", `Tether is on, but the ${which} connection dropped. It reconnects and resumes by itself; nothing is traded meanwhile.`);
    }
    if (s.pt.status !== "live" || s.hl.status !== "live" || !pt || !h) {
      return setStatus("Connecting", "warn", `Connecting to papertrade (${s.pt.status}) and Hyperliquid (${s.hl.status})…`);
    }
    const off = Math.abs(s.delta?.deltaUsd ?? 0);
    const open = pt.netSize !== 0 || h.size !== 0;
    const trade = (s.rounds ?? []).find((r) => r.hedge && ["opening", "hedging", "live", "closing", "flattening"].includes(r.state));
    if (s.auto) {
      if (s.hold) return setStatus("Linked", "up", "Linked. Papertrade's close is queued, so Hyperliquid stays hedged until it fills.");
      if (!open) return setStatus("Linked", "up", "Linked and waiting. When a papertrade position fills, Hyperliquid opens the opposite side.");
      if (off > band) return setStatus("Rebalancing", "warn", `Linked, catching up: the legs are off by ${usd(off, 0)}, so Hyperliquid is being traded to match papertrade.`);
      return setStatus("Linked", "up", `Linked. Hyperliquid holds the opposite of your papertrade position and follows its fills.`);
    }
    const stop = s.alerts.find((a) => /^Tether stopped/.test(a.text) && Date.now() - a.at < STOPPED_SHOWN_MS);
    if (stop) return setStatus("Stopped", "dn", `${stop.text}. Fix that, then turn Tether back on.`, true);
    if (trade) return setStatus("Linked by trade", "up", "Your hedged trade is managing the Hyperliquid leg. Turn on Tether to also follow positions you open by hand.");
    if (open && off > band) return setStatus("Not linked", "warn", `Tether is off and the legs are off by ${usd(off, 0)}. Turn it on to hedge, or press Hedge to 100% once.`, true);
    return setStatus("Not linked", "", "Tether is off: trades you place on papertrade won't be hedged on Hyperliquid.", true);
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
  function confirm(text, run, { needsKey = false } = {}) {
    pendingConfirm = run;
    ui["hx-confirm-t"].textContent = text;
    ui["hx-xkey"].hidden = !needsKey;
    ui["hx-xkey"].value = "";
    ui["hx-confirm"].hidden = false;
    ui["hx-confirm"].scrollIntoView({ block: "nearest", behavior: "smooth" });
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
      else if (act === "tether-on") {
        await send("setAuto", { on: true });
        flash("ok", "Tether on: papertrade fills are now hedged on Hyperliquid");
      }
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
        // an older saved-and-unlocked key signs on its own; otherwise the user pastes theirs for this transfer
        const needsKey = !snap.vault.unlocked;
        const mode = snap.vault.connection?.mode ?? "key";
        confirm(
          `Send $${amount} USDC from ${short(snap.settings.hedgeWallet)} to papertrade ${short(snap.settings.ptWallet)}`,
          () => {
            const secret = needsKey ? { mode, secret: ui["hx-xkey"].value.trim() } : null;
            ui["hx-xkey"].value = "";
            if (needsKey && !secret.secret) throw new Error("Paste your key to sign the transfer");
            return send("sendToPapertrade", { amount, secret });
          },
          { needsKey },
        );
      } else if (act === "toHl") openPapertradeWithdraw();
      else if (act === "confirm") {
        const run = pendingConfirm;
        pendingConfirm = null;
        ui["hx-confirm"].hidden = true;
        await run();
        ui["hx-xkey"].value = "";
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
