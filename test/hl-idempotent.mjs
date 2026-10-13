// Offline test of hl.js order idempotency: fetch is replaced with a fake Hyperliquid, so no
// request leaves the machine. Run: node test/hl-idempotent.mjs
import { webcrypto } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createHl } from "../src/hl.js";

globalThis.crypto ??= webcrypto;

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

// ---------- fake Hyperliquid ----------
const exchangeLog = [];
const landed = new Map(); // cloid -> order
let mode = "lostResponse";
let infoFailures = 0;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).endsWith("/info")) {
    if (infoFailures-- > 0) throw new TypeError("fetch failed");
    switch (body.type) {
      case "meta":
        return json({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }], marginTables: [] });
      case "allMids":
        return json({ BTC: "82000" });
      case "maxBuilderFee":
        return json(50);
      case "orderStatus": {
        const o = landed.get(body.oid);
        if (!o) return json({ status: "unknownOid" });
        return json({
          status: "order",
          order: {
            order: { coin: "BTC", side: o.b ? "B" : "A", limitPx: o.p, sz: "0.0", oid: 777, timestamp: Date.now(), triggerCondition: "N/A", isTrigger: false, triggerPx: "0.0", children: [], isPositionTpsl: false, reduceOnly: o.r, orderType: "Market", origSz: o.s, tif: "Ioc", cloid: body.oid },
            status: "filled",
            statusTimestamp: Date.now(),
          },
        });
      }
    }
    throw new Error(`unexpected info ${body.type}`);
  }
  // /exchange
  exchangeLog.push(body.action);
  const o = body.action.orders[0];
  if (mode === "lostResponse" && exchangeLog.length === 1) {
    landed.set(o.c, o); // the order reached the exchange…
    throw new TypeError("fetch failed"); // …but the response never came back
  }
  if (mode === "neverLanded" && exchangeLog.length === 1) throw new TypeError("fetch failed");
  if (mode === "rejected") return json({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin to place order." }] } } });
  landed.set(o.c, o);
  return json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: o.s, avgPx: "82010", oid: 778 } }] } } });
};

const signer = privateKeyToAccount(generatePrivateKey());
const order = { coin: "BTC", isBuy: false, size: 0.12195, reduceOnly: false, slippageBps: 30, builderFee: false };

// 1: request lands, response lost → orderStatus says filled → no resend
{
  const hl = createHl({ testnet: true });
  const fill = await hl.marketOrder(signer, order);
  check(exchangeLog.length === 1, `lost response: order sent once (${exchangeLog.length})`);
  check(fill.size === 0.12195, `lost response: fill recovered from orderStatus (${fill.size} BTC)`);
}

// 2: request never lands → orderStatus unknown → resent with the same cloid, fills once
{
  exchangeLog.length = 0;
  landed.clear();
  mode = "neverLanded";
  const hl = createHl({ testnet: true });
  const fill = await hl.marketOrder(signer, order);
  check(exchangeLog.length === 2, `never landed: resent once (${exchangeLog.length} sends)`);
  check(exchangeLog[0].orders[0].c === exchangeLog[1].orders[0].c, "resend reuses the same cloid");
  check(fill.size === 0.12195, "never landed: filled on resend");
}

// 3: exchange rejection is not retried
{
  exchangeLog.length = 0;
  mode = "rejected";
  const hl = createHl({ testnet: true });
  let err = null;
  try {
    await hl.marketOrder(signer, order);
  } catch (e) {
    err = e;
  }
  check(err && exchangeLog.length === 1, `rejection thrown without retry (${exchangeLog.length} sends): ${err?.message?.slice(0, 60)}`);
}

// 3b: an agent (trading key) signs for the hedge wallet — the lost-response check must look up
// the order under the hedge wallet, not the agent's own address
{
  exchangeLog.length = 0;
  landed.clear();
  mode = "lostResponse";
  const queried = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.type === "orderStatus") queried.push(b.user);
    return realFetch(url, init);
  };
  const agent = privateKeyToAccount(generatePrivateKey());
  agent.user = "0x00000000000000000000000000000000000000aa";
  const hl = createHl({ testnet: true });
  const fill = await hl.marketOrder(agent, order);
  globalThis.fetch = realFetch;
  check(exchangeLog.length === 1 && fill.size === 0.12195, "agent: lost response recovered without resending");
  check(queried.length === 1 && queried[0] === agent.user, `agent: order status looked up under the hedge wallet (${queried[0]})`);
}

// 4: reads survive transient failures
{
  mode = "ok";
  infoFailures = 2;
  const hl = createHl({ testnet: true });
  const m = await hl.mid("BTC");
  check(m === 82000, "allMids retried through 2 network failures");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
