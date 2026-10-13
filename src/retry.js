// Retry only what is safe to retry. Network/timeout/5xx failures are transient; an exchange
// rejecting an action (bad price, insufficient margin, …) is not, and is thrown straight away.
// Fund-moving calls are NOT wrapped here blindly — they go through idempotent helpers that
// check whether the first attempt landed before trying again (see hl.js placeIdempotent).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isTransient(err) {
  const name = err?.name ?? "";
  const msg = String(err?.message ?? err);
  if (name === "AbortError" || name === "TimeoutError" || name === "TypeError") return true; // fetch network failure
  if (/HttpRequestError|TransportError|WebSocketRequestError/.test(name)) {
    const status = err?.response?.status;
    return status === undefined || status === 429 || status >= 500;
  }
  return /timed? ?out|network|fetch failed|ECONNRESET|socket hang up|429|502|503|504/i.test(msg);
}

export async function withRetry(fn, { tries = 4, baseMs = 300, maxMs = 4000, label = "request" } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      last = err;
      if (!isTransient(err) || i === tries - 1) break;
      await sleep(Math.min(maxMs, baseMs * 2 ** i) * (0.75 + Math.random() * 0.5));
    }
  }
  throw new Error(`${label} failed: ${last?.message ?? last}`, { cause: last });
}

export function newCloid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
