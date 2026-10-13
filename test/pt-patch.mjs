// Offline: papertrade `wallet` events carry full frames and diffs (diff = has baseAccountRevision).
import assert from "node:assert/strict";
import { applyPatch, isPatch, summarize } from "../src/papertrade.js";

const funds = { reservedBalance: "0", reservedQueued: "0", availableBalance: "4359569018416725807682", availableQueued: "0" };
const full = { address: "0xabc", accountRevision: 10, balance: "4359569018416725807682", queued: "0", funds, openPositions: [], operations: [["0xop1", "openPosition"]], lifetime: { realizedPnlRaw: "0" } };
assert.equal(isPatch(full), false);

// Opening a position: funds change, the queued intent leaves, a position appears.
const patch = {
  address: "0xabc", baseAccountRevision: 10, accountRevision: 11,
  state: { funds: { ...funds, availableBalance: "4209569018416725807682" } },
  addedPositions: [["41900", 0, true, false, "830000", "150000000000000000000", 789, "829000", 1791660000000, "0xop1"]],
  removedPositionIds: [], addedOperations: [], removedOperationIds: ["0xop1"],
};
assert.equal(isPatch(patch), true);
const next = applyPatch(full, patch);
assert.equal(next.funds.availableBalance, "4209569018416725807682");
assert.equal(next.balance, full.balance, "fields absent from the patch keep their value");
assert.equal(next.openPositions.length, 1);
assert.equal(next.operations.length, 0, "finished intents leave the queue");
assert.equal(next.accountRevision, 11);

// A patch with no state change still keeps funds (the bug: treating it as a full frame dropped them).
const quiet = applyPatch(next, { ...patch, baseAccountRevision: 11, accountRevision: 12, state: {}, addedPositions: [], removedPositionIds: ["41900"], removedOperationIds: [] });
assert.equal(quiet.funds.availableBalance, "4209569018416725807682");
assert.equal(quiet.openPositions.length, 0);
summarize(quiet, "BTC", 83000, 0);

assert.throws(() => applyPatch(quiet, { ...patch, baseAccountRevision: 99, accountRevision: 100 }), /out of sync/);
console.log("pt-patch ok");
