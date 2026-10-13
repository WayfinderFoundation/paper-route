// Read-only smoke test: no orders, no transfers.
import { createHl, roundPrice, roundSize } from "../src/hl.js";
import { summarize, winFeeRate, depositProxy } from "../src/papertrade.js";
import { localKeySigner } from "../src/signers.js";
import { generatePrivateKey } from "viem/accounts";
import { verifyTypedData } from "viem";

const assert = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); console.log(`ok  ${m}`); };

const hl = createHl();
const meta = await hl.loadMeta();
assert(meta.BTC && meta.BTC.asset === 0, `BTC meta asset=${meta.BTC.asset} szDecimals=${meta.BTC.szDecimals}`);
const acct = await hl.account("0x0000000000000000000000000000000000000001", "BTC");
assert(acct.mid > 1000 && acct.size === 0, `account read mid=${acct.mid}`);
assert(roundSize(0.123456789, 5) === 0.12345, "roundSize floors to szDecimals");
assert(roundPrice(82744.567, 5) === "82745", `roundPrice 5 sig figs -> ${roundPrice(82744.567, 5)}`);
assert(roundPrice(3.14159, 2) === "3.1416", `roundPrice small -> ${roundPrice(3.14159, 2)}`);

const fee = await winFeeRate();
assert(Math.abs(fee - 0.02) < 1e-9, `winFeeRate=${fee}`);
const proxy = await depositProxy("0x0000000000000000000000000000000000000001");
assert(/^0x[0-9a-f]{40}$/.test(proxy), `deposit proxy ${proxy}`);

// synthetic papertrade frame: one 198x long, $100 margin at the current mid
const mid = acct.mid;
const entryRaw = BigInt(Math.round(mid * 10)) * 10n ** 18n; // price scale guessed; summarize infers it
const bustRaw = BigInt(Math.round(mid * (1 - 1 / 198) * 10)) * 10n ** 18n;
const frame = {
  balance: (500n * 10n ** 18n).toString(), queued: "0",
  funds: { availableBalance: (400n * 10n ** 18n).toString(), availableQueued: "0" },
  openPositions: [["1", 0, true, false, entryRaw.toString(), (100n * 10n ** 18n).toString(), 198, bustRaw.toString(), Date.now(), null]],
};
const s = summarize(frame, "BTC", mid * 1.001, fee);
assert(Math.abs(s.netSize - (100 * 198) / mid) < 1e-6, `pt netSize=${s.netSize.toFixed(5)} BTC`);
assert(Math.abs(s.uPnl - s.netSize * mid * 0.001) < 0.01 && s.uPnlAfterFee < s.uPnl, `pt uPnl=${s.uPnl.toFixed(2)} afterFee=${s.uPnlAfterFee.toFixed(2)}`);
assert(Math.abs(s.bust / mid - (1 - 1 / 198)) < 1e-6, `pt bust=${s.bust.toFixed(1)}`);

const signer = localKeySigner(generatePrivateKey());
const td = { domain: { name: "t", version: "1", chainId: 1337 }, types: { Ping: [{ name: "at", type: "uint64" }] }, primaryType: "Ping", message: { at: 1n } };
const sig = await signer.signTypedData(td);
assert(await verifyTypedData({ address: signer.address, ...td, signature: sig }), "local signer typed-data signature verifies");
let threw = false;
try { localKeySigner(generatePrivateKey(), "0x0000000000000000000000000000000000000001"); } catch { threw = true; }
assert(threw, "local signer rejects a key for a different wallet");
console.log("ALL PASS");
