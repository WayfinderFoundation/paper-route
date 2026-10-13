// Key storage. Two secrets with different blast radius:
//
// 1. Trading key — a Hyperliquid API ("agent") wallet generated here and approved once by the
//    hedge wallet. It can place/cancel orders and set leverage but cannot withdraw or transfer,
//    so it is kept always-available: encrypted with a non-extractable AES-GCM device key that
//    lives in IndexedDB. It survives extension reloads and browser restarts.
//
// 2. Main secret — the hedge wallet's private key or a Wayfinder `wk_` API key. Needed for
//    transfers (HL → papertrade) and one-time approvals. At rest it is encrypted under a
//    passphrase (PBKDF2 600k → AES-GCM). Unlocking re-wraps it under the device key with an
//    expiry ("unlocked until"), so it also survives reloads/restarts until the window ends.
//
// The device key can't be exported from WebCrypto, so the ciphertext in chrome.storage.local is
// useless without this browser profile. Secrets never leave the service worker.

const PBKDF2_ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------- device key (non-extractable, IndexedDB) ----------
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("wf-vault", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbOp(mode, fn) {
  return idb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("keys", mode);
        const req = fn(tx.objectStore("keys"));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

let deviceKeyPromise = null;
function deviceKey() {
  deviceKeyPromise ??= (async () => {
    const existing = await idbOp("readonly", (s) => s.get("device"));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idbOp("readwrite", (s) => s.put(key, "device"));
    return key;
  })();
  return deviceKeyPromise;
}

async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: b64(iv), ct: b64(ct) };
}

async function open(key, box) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(plain));
}

async function passphraseKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ---------- main secret ----------
export async function storeSecret({ mode, secret, passphrase, unlockHours }) {
  if (!passphrase || passphrase.length < 8) throw new Error("Choose a passphrase of at least 8 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const boxed = await seal(await passphraseKey(passphrase, salt), { mode, secret });
  await chrome.storage.local.set({ vault: { salt: b64(salt), ...boxed } });
  await setUnlocked({ mode, secret }, unlockHours);
}

async function setUnlocked(secret, hours) {
  const until = Date.now() + Math.max(0.25, hours) * 3600_000;
  await chrome.storage.local.set({ unlocked: { ...(await seal(await deviceKey(), secret)), until } });
  return until;
}

export async function unlock(passphrase, unlockHours = 8) {
  const { vault } = await chrome.storage.local.get("vault");
  if (!vault) throw new Error("No key stored — add one in settings");
  let secret;
  try {
    secret = await open(await passphraseKey(passphrase, unb64(vault.salt)), vault);
  } catch {
    throw new Error("Wrong passphrase");
  }
  return setUnlocked(secret, unlockHours);
}

export async function lock() {
  await chrome.storage.local.remove("unlocked");
}

export async function forget() {
  await chrome.storage.local.remove(["vault", "unlocked"]);
}

// the main secret if it's inside its unlock window, else null (and the window is closed)
export async function getSecret() {
  const { unlocked } = await chrome.storage.local.get("unlocked");
  if (!unlocked) return null;
  if (Date.now() > unlocked.until) {
    await lock();
    return null;
  }
  return open(await deviceKey(), unlocked);
}

// ---------- trading (agent) key ----------
export async function storeAgent({ privateKey, address, hedgeWallet, network, validUntil }) {
  const boxed = await seal(await deviceKey(), { privateKey });
  await chrome.storage.local.set({ agent: { ...boxed, address, hedgeWallet: hedgeWallet.toLowerCase(), network, validUntil } });
}

// the agent key, only if it was approved for this hedge wallet on this network and hasn't expired
export async function getAgent(hedgeWallet, network) {
  const { agent } = await chrome.storage.local.get("agent");
  if (!agent || agent.hedgeWallet !== hedgeWallet.toLowerCase() || agent.network !== network) return null;
  if (agent.validUntil && Date.now() > agent.validUntil) return null;
  const { privateKey } = await open(await deviceKey(), agent);
  return { privateKey, address: agent.address };
}

export async function forgetAgent() {
  await chrome.storage.local.remove("agent");
}

export async function vaultStatus() {
  const { vault, unlocked, agent } = await chrome.storage.local.get(["vault", "unlocked", "agent"]);
  const live = unlocked && Date.now() <= unlocked.until;
  let mode = null;
  if (live) mode = (await getSecret())?.mode ?? null;
  return {
    remembered: !!vault,
    unlocked: !!live,
    unlockedUntil: live ? unlocked.until : null,
    mode,
    agent: agent ? { address: agent.address, hedgeWallet: agent.hedgeWallet, network: agent.network, validUntil: agent.validUntil } : null,
  };
}
