const result = document.getElementById("result");

function show(text, ok) {
  result.textContent = text;
  result.className = `result ${ok ? "ok" : "bad"}`;
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(["hudPos", "hudCollapsed", "overlayEnabled"]);
  show("HUD position reset — reload papertrade", true);
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
  showKey("Hedge settings saved", true);
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
