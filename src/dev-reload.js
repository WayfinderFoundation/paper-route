// Dev only (unpacked install has no update_url): reload the extension when any of its files
// change, so edits on disk never run as a half-updated mix of old script + new CSS.
const DEV_WATCH = ["manifest.json", "dist/background.js", "content.js", "hedge-ui.js", "chart-bridge.js", "hud.css", "options.html", "options.js"];

// __DEV__ is an esbuild define: true for `npm run build`, false in the release bundle
if (__DEV__ && !("update_url" in chrome.runtime.getManifest())) {
  // Chrome keeps running the worker script it cached at the last extension load, even after a
  // rebuild while it slept; this copy's build id must be in the bundle on disk, else reload.
  fetch(chrome.runtime.getURL("dist/background.js"), { cache: "no-store" })
    .then((r) => r.text())
    .then((text) => {
      if (!text.includes(__BUILD_ID__)) chrome.runtime.reload();
    })
    .catch(() => {});
  let fingerprint = null;
  setInterval(async () => {
    const texts = await Promise.all(DEV_WATCH.map((f) => fetch(chrome.runtime.getURL(f), { cache: "no-store" }).then((r) => (r.ok ? r.text() : ""), () => "")));
    const next = texts.join("\u0000");
    if (fingerprint !== null && next !== fingerprint) chrome.runtime.reload();
    fingerprint = next;
  }, 1000);
}
