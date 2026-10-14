const result = document.getElementById("result");

function show(text, ok) {
  result.textContent = text;
  result.className = `result ${ok ? "ok" : "bad"}`;
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(["hudPos", "hudCollapsed", "overlayEnabled", "flowOpen"]);
  show("Panel position and layout reset. Reload papertrade to see it.", true);
});

// ---------- hedge ----------
const HEDGE_FIELDS = ["bandUsd", "slippageBps", "maxOrderUsd", "maxPositionUsd", "roundMarginUsd", "marginK", "builderFee", "safetyNet"];
const HEDGE_DEFAULTS = { slippageBps: 30, bandUsd: 50, maxOrderUsd: 25000, maxPositionUsd: 50000, builderFee: true, marginK: 3, roundMarginUsd: 100, safetyNet: true };
const $id = (id) => document.getElementById(id);
const keyResult = $id("keyResult");

function showKey(text, ok) {
  keyResult.textContent = text;
  keyResult.className = `result ${ok ? "ok" : "bad"}`;
}

function hedgeCmd(cmd, args) {
  return chrome.runtime.sendMessage({ target: "hedge", cmd, args }).then((r) => {
    if (!r?.ok) throw new Error(r?.error ?? "No response from the hedge engine (rebuild with npm run build)");
    return r.data;
  });
}

chrome.storage.local.get("hedgeSettings").then(({ hedgeSettings }) => {
  const s = { ...HEDGE_DEFAULTS, ...hedgeSettings };
  for (const f of HEDGE_FIELDS) {
    const node = $id(f);
    if (node.type === "checkbox") node.checked = !!s[f];
    else node.value = s[f] ?? "";
  }
});

$id("saveHedge").addEventListener("click", async () => {
  const s = {};
  for (const f of HEDGE_FIELDS) {
    const node = $id(f);
    s[f] = node.type === "checkbox" ? node.checked : node.type === "number" ? Number(node.value) : node.value.trim();
  }
  // keep fields set elsewhere (the hedge wallet comes from Connect, HL leverage from the HUD)
  const { hedgeSettings: prev } = await chrome.storage.local.get("hedgeSettings");
  await chrome.storage.local.set({ hedgeSettings: { ...prev, ...s } });
  show("Settings saved", true);
});

const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
let reconnecting = false;

// Connected = a live trading key for the wallet in settings. Otherwise, the Connect form.
async function refreshStatus() {
  let v;
  let settings;
  try {
    v = await hedgeCmd("vaultStatus");
    settings = (await chrome.storage.local.get("hedgeSettings")).hedgeSettings ?? {};
  } catch {
    $id("mainStatus").textContent = "—";
    return;
  }
  const wallet = settings.hedgeWallet?.toLowerCase();
  const connected = !!v.agent && v.agent.validUntil > Date.now() && v.agent.hedgeWallet === wallet;
  const showCard = connected && !reconnecting;
  for (const id of ["connected", "connectedLead", "connectedActions"]) $id(id).hidden = !showCard;
  $id("connectForm").hidden = showCard;
  $id("cancelReconnect").hidden = !reconnecting;
  $id("step1").className = `step${connected ? " done" : ""}`;
  $id("step1").textContent = connected ? "✓" : "1";
  const expired = v.agent && v.agent.validUntil <= Date.now();
  $id("mainStatus").textContent = connected ? "Connected" : expired ? "Expired, connect again" : "Not connected";
  $id("mainStatus").className = `pill ${connected ? "ok" : expired ? "warn" : ""}`;
  if (!connected) return;
  $id("connLabel").textContent = `${short(settings.hedgeWallet)}${v.connection?.mode === "wayfinder" ? " · Wayfinder" : ""}`;
  $id("connLabel").title = settings.hedgeWallet;
  $id("tradeStatus").textContent = `Ready until ${fmtDate(v.agent.validUntil)}`;
}
refreshStatus();
setInterval(refreshStatus, 5000);

$id("mode").addEventListener("change", () => {
  const wf = $id("mode").value === "wayfinder";
  $id("secret").placeholder = wf ? "wk_…" : "0x…";
  $id("secretLabel").textContent = wf ? "Wayfinder API key" : "Private key";
  $id("wfNote").hidden = !wf;
  $id("wfWalletRow").hidden = !wf;
});

$id("connect").addEventListener("click", async () => {
  const btn = $id("connect");
  btn.disabled = true;
  showKey("Connecting: approving a trading key and the builder fee on Hyperliquid…", true);
  try {
    const r = await hedgeCmd("connect", { mode: $id("mode").value, secret: $id("secret").value, wallet: $id("wfWallet").value.trim() });
    reconnecting = false;
    showKey(`✓ Connected ${short(r.address)}. Your key wasn't stored. Hedging is ready on papertrade.`, true);
  } catch (err) {
    showKey(`✗ ${err.message}`, false);
  } finally {
    $id("secret").value = "";
    btn.disabled = false;
    refreshStatus();
  }
});

$id("reconnect").addEventListener("click", () => {
  reconnecting = true;
  showKey("Paste the key of the wallet to use. Paper Route switches to it and sets up hedging there.", true);
  refreshStatus();
});

$id("cancelReconnect").addEventListener("click", () => {
  reconnecting = false;
  showKey("", true);
  refreshStatus();
});

$id("disconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect Hyperliquid? Paper Route removes its trading key from this browser and stops hedging. To revoke it on Hyperliquid too, use Hyperliquid's API page.")) return;
  try {
    await hedgeCmd("disconnect");
    showKey("Disconnected. Revoke the trading key on Hyperliquid's API page if you won't reconnect.", true);
  } catch (err) {
    showKey(`✗ ${err.message}`, false);
  }
  refreshStatus();
});

// ---------- tooltips ----------
// Labels with data-tip show their explanation in one floating bubble on hover or keyboard focus.
const tip = document.querySelector(".tip");
function showTip(target) {
  tip.textContent = target.dataset.tip;
  tip.classList.add("on");
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left));
  const above = r.top - t.height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${above >= 8 ? above : r.bottom + 8}px`;
}
const hideTip = () => tip.classList.remove("on");
for (const type of ["pointerover", "focusin"]) {
  document.addEventListener(type, (e) => {
    const t = e.target.closest("[data-tip]");
    if (t) showTip(t);
    else hideTip();
  });
}
window.addEventListener("scroll", hideTip, true);

// ---------- dropdowns ----------
// Chrome draws a <select>'s option list in OS colours, so each select[data-dd] gets a styled
// trigger + menu. The select stays the source of truth: code reads its .value and hears "change".
const CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';

function dropdown(select) {
  const wrap = document.createElement("div");
  wrap.className = "dd";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dd-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = document.createElement("ul");
  menu.className = "dd-menu";
  menu.setAttribute("role", "listbox");
  const items = [...select.options].map((o) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.value = o.value;
    const text = document.createElement("span");
    text.textContent = o.textContent;
    if (o.dataset.sub) {
      const sub = document.createElement("small");
      sub.textContent = o.dataset.sub;
      text.append(sub);
    }
    li.append(text);
    li.insertAdjacentHTML("beforeend", CHECK);
    menu.append(li);
    return li;
  });
  wrap.append(trigger, menu);
  select.after(wrap);

  let active = -1;
  const sync = () => {
    const label = document.createElement("span");
    label.textContent = select.selectedOptions[0]?.textContent ?? "";
    trigger.replaceChildren(label);
    trigger.insertAdjacentHTML("beforeend", CHEVRON);
    for (const li of items) li.setAttribute("aria-selected", String(li.dataset.value === select.value));
  };
  const setActive = (i) => {
    active = (i + items.length) % items.length;
    items.forEach((li, j) => li.classList.toggle("active", j === active));
  };
  const open = (on) => {
    menu.classList.toggle("open", on);
    trigger.setAttribute("aria-expanded", String(on));
    if (on) setActive(Math.max(0, select.selectedIndex));
  };
  const choose = (value) => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    open(false);
    trigger.focus();
  };
  trigger.addEventListener("click", () => open(!menu.classList.contains("open")));
  trigger.addEventListener("keydown", (e) => {
    const isOpen = menu.classList.contains("open");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) open(true);
      else setActive(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if ((e.key === "Enter" || e.key === " ") && isOpen) {
      e.preventDefault();
      choose(items[active].dataset.value);
    } else if (e.key === "Escape") open(false);
  });
  menu.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (li) choose(li.dataset.value);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!wrap.contains(e.target)) open(false);
  });
  select.addEventListener("change", sync);
  sync();
}
document.querySelectorAll("select[data-dd]").forEach(dropdown);
