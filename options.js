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
const HEDGE_FIELDS = ["ptWallet", "hedgeWallet", "network", "bandUsd", "slippageBps", "maxOrderUsd", "maxPositionUsd", "roundMarginUsd", "marginK", "builderFee", "safetyNet"];
const HEDGE_DEFAULTS = { network: "mainnet", slippageBps: 30, bandUsd: 50, maxOrderUsd: 25000, maxPositionUsd: 50000, builderFee: true, marginK: 3, roundMarginUsd: 100, safetyNet: true };
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
    if (s[f] && !/^0x[0-9a-fA-F]{40}$/.test(s[f])) return showKey(`${f} isn't a valid address`, false);
  }
  if (s.ptWallet && s.ptWallet.toLowerCase() === s.hedgeWallet.toLowerCase()) return showKey("Papertrade and hedge wallets must differ", false);
  // keep fields set elsewhere (HL leverage is picked in the HUD)
  const { hedgeSettings: prev } = await chrome.storage.local.get("hedgeSettings");
  await chrome.storage.local.set({ hedgeSettings: { ...prev, ...s } });
  showKey("Hedge settings saved", true);
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
    $id("agentStatus").textContent = v.agent ? `${v.agent.address.slice(0, 6)}…${v.agent.address.slice(-4)} · ${v.agent.network} · until ${new Date(v.agent.validUntil).toLocaleDateString()}` : "Not set up";
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
  showAgent("Trading key removed from this browser — revoke it on Hyperliquid's API page too", true);
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
