// Cost per Paper of a finished delta-neutral trade (src/dncost.js). Run: node test/dncost.mjs
import { dnCost } from "../src/dncost.js";

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

{
  console.log("# hedged on Hyperliquid (the 8-trade session of 2026-10-14)");
  const c = dnCost({
    coin: "BTC",
    pt: { 1: { paidUsd: 20.888897, paper: 308.119157, liquidated: false } },
    hl: {
      fills: [
        { coin: "BTC", closedPnl: "-35.933731", fee: "117.945215", builderFee: "36.290828" },
        { coin: "ETH", closedPnl: "100", fee: "5", builderFee: "1" }, // another coin: ignored
      ],
      funding: [{ delta: { coin: "BTC", usdc: "-0.047644" } }, { delta: { coin: "ETH", usdc: "9" } }],
    },
  });
  check(near(c.net, 20.888897 - 35.933731 - 117.945215 - 0.047644), `net ${c.net.toFixed(2)} = papertrade + HL P&L − fees + funding`);
  check(near(c.hl.builder, 36.290828), "builder fee broken out (already inside the fee)");
  check(near(c.costPerPaper, -c.net / 308.119157) && c.costPerPaper > 0.43 && c.costPerPaper < 0.44, `cost per Paper $${c.costPerPaper.toFixed(4)}`);
}

{
  console.log("\n# a papertrade pair: no Hyperliquid part");
  const c = dnCost({ coin: "ETH", pt: { 10: { paidUsd: 4.2, paper: 120, liquidated: false }, 11: { paidUsd: -10, paper: 900, liquidated: true } }, hl: null });
  check(c.venue === "pt" && c.hl === null && c.legs === 2 && c.liquidated, "both legs, one liquidated");
  check(near(c.net, -5.8) && near(c.costPerPaper, 5.8 / 1020), `net −$5.80, $${c.costPerPaper.toFixed(4)} per Paper`);
}

{
  console.log("\n# no Paper minted");
  const c = dnCost({ coin: "BTC", pt: { 1: { paidUsd: -2, paper: 0 } }, hl: null });
  check(c.costPerPaper === null, "no cost per Paper without Paper");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
