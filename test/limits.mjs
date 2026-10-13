// Read-only: papertrade's live limits and the capacity maths. No orders.
import { tradingLimits, sideRoomUsd } from "../src/papertrade.js";
import { roundCapacity, bustDistance } from "../src/capacity.js";
const mid = Number((await (await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) })).json()).BTC);
const l = await tradingLimits("BTC");
const { oi, ...rest } = l;
console.log("mid", mid, rest);
console.log("room long $", Math.round(sideRoomUsd(l, true, mid)).toLocaleString(), "room short $", Math.round(sideRoomUsd(l, false, mid)).toLocaleString());
for (const lev of [100, 198]) console.log(`bust distance at ${lev}x: ${(bustDistance(lev, l.bustBuffer) * 100).toFixed(4)}%`);
const cap = roundCapacity({ isPaperLong: true, ptLeverage: 100, hedge: true, ptAvailable: 1660, ptLimits: { ...l, sideRoomUsd: sideRoomUsd(l, true, mid) }, hlAvailableToTrade: [500, 500], hlLeverage: 10, hlMaxLeverage: 40, maxOrderUsd: 25000, maxPositionUsd: 50000 });
console.log("example: $1,660 papertrade + $500 HL free @10x, paper 100x long →", { maxMargin: cap.maxMargin, minMargin: cap.minMargin, binding: cap.binding, problems: cap.problems });
