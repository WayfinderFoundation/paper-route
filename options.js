const result = document.getElementById("result");

function show(text, ok) {
  result.textContent = text;
  result.className = `result ${ok ? "ok" : "bad"}`;
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(["hudPos", "hudCollapsed", "hudSections", "overlayEnabled"]);
  show("HUD position and layout reset. Reload papertrade to see it.", true);
});

// ---------- hedge ----------
const HEDGE_FIELDS = ["ptWallet", "hedgeWallet", "bandUsd", "slippageBps", "maxOrderUsd", "maxPositionUsd", "roundMarginUsd", "marginK", "builderFee", "safetyNet"];
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
  for (const f of ["ptWallet", "hedgeWallet"]) {
    if (s[f] && !/^0x[0-9a-fA-F]{40}$/.test(s[f])) return show(`${f === "ptWallet" ? "Papertrade wallet" : "Hedge wallet"} isn't a valid address`, false);
  }
  if (s.ptWallet && s.ptWallet.toLowerCase() === s.hedgeWallet.toLowerCase()) return show("Papertrade and hedge wallets must differ", false);
  // keep fields set elsewhere (HL leverage is picked in the HUD)
  const { hedgeSettings: prev } = await chrome.storage.local.get("hedgeSettings");
  await chrome.storage.local.set({ hedgeSettings: { ...prev, ...s } });
  show("Hedge settings saved", true);
});

const agentResult = $id("agentResult");
function showAgent(text, ok) {
  agentResult.textContent = text;
  agentResult.className = `result ${ok ? "ok" : "bad"}`;
}

const fmtUntil = (ms) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

async function refreshStatus() {
  try {
    const v = await hedgeCmd("vaultStatus");
    $id("mainStatus").textContent = !v.remembered ? "Not set" : v.unlocked ? `Unlocked until ${fmtUntil(v.unlockedUntil)}` : "Locked";
    $id("agentStatus").textContent = v.agent ? `${v.agent.address.slice(0, 6)}…${v.agent.address.slice(-4)} · until ${new Date(v.agent.validUntil).toLocaleDateString()}` : "Not set up";
  } catch {
    $id("mainStatus").textContent = "—";
  }
}
refreshStatus();
setInterval(refreshStatus, 5000);

$id("storeKey").addEventListener("click", async () => {
  try {
    await hedgeCmd("storeSecret", {
      mode: $id("mode").value,
      secret: $id("secret").value.trim(),
      passphrase: $id("passphrase").value,
      unlockHours: Number($id("unlockHours").value),
    });
    $id("secret").value = "";
    $id("passphrase").value = "";
    showKey("Key stored (encrypted) and unlocked", true);
    refreshStatus();
  } catch (err) {
    showKey(`✗ ${err.message}`, false);
  }
});

$id("unlockKey").addEventListener("click", async () => {
  try {
    const { until } = await hedgeCmd("unlock", { passphrase: $id("passphrase").value, hours: Number($id("unlockHours").value) });
    $id("passphrase").value = "";
    showKey(`Unlocked until ${fmtUntil(until)}`, true);
    refreshStatus();
  } catch (err) {
    showKey(`✗ ${err.message}`, false);
  }
});

$id("lockKey").addEventListener("click", async () => {
  await hedgeCmd("lock");
  showKey("Locked", true);
  refreshStatus();
});

$id("setupAgent").addEventListener("click", async () => {
  try {
    showAgent("Approving on Hyperliquid…", true);
    const r = await hedgeCmd("setupAgent");
    showAgent(`✓ trading key ${r.address} approved until ${new Date(r.validUntil).toLocaleDateString()}`, true);
    refreshStatus();
  } catch (err) {
    showAgent(`✗ ${err.message}`, false);
  }
});

$id("forgetAgent").addEventListener("click", async () => {
  await hedgeCmd("forgetAgent");
  showAgent("Trading key removed from this browser. Revoke it on Hyperliquid's API page too.", true);
  refreshStatus();
});

$id("testKey").addEventListener("click", async () => {
  try {
    const r = await hedgeCmd("testSigner");
    showKey(`✓ signed as ${r.address} (${r.signature})`, true);
  } catch (err) {
    showKey(`✗ ${err.message}`, false);
  }
});

$id("forgetKey").addEventListener("click", async () => {
  try {
    await hedgeCmd("forget");
    showKey("Key forgotten", true);
  } catch (err) {
    showKey(`✗ ${err.message}`, false);
  }
});

// ---------- tooltips ----------
// Labels with data-tip show their explanation in one floating tooltip on hover or keyboard focus.
const tooltip = document.querySelector(".tooltip");
function showTip(target) {
  tooltip.textContent = target.dataset.tip;
  tooltip.classList.add("on");
  const r = target.getBoundingClientRect();
  const t = tooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left));
  const above = r.top - t.height - 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${above >= 8 ? above : r.bottom + 8}px`;
}
const hideTip = () => tooltip.classList.remove("on");
document.addEventListener("pointerover", (e) => {
  const t = e.target.closest("[data-tip]");
  if (t) showTip(t);
  else hideTip();
});
document.addEventListener("focusin", (e) => {
  const t = e.target.closest("[data-tip]");
  if (t) showTip(t);
  else hideTip();
});
window.addEventListener("scroll", hideTip, true);

// ---------- dropdowns ----------
// Chrome draws a <select>'s option list with OS colours, so each select[data-dd] gets a styled
// trigger + menu. The select stays the source of truth: code reads and sets its .value as before.
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
    trigger.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = select.selectedOptions[0]?.textContent ?? "";
    trigger.append(label);
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
    sync();
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

// the note under the key fields follows the chosen mode
const syncModeNote = () => {
  const wayfinder = $id("mode").value === "wayfinder";
  $id("wayfinderNote").hidden = !wayfinder;
  $id("rawNote").hidden = wayfinder;
};
$id("mode").addEventListener("change", syncModeNote);
syncModeNote();
