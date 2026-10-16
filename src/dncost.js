// What a finished delta-neutral trade cost per Paper earned. Pure: the engine fetches the inputs.
//
// pt: { positionId → { paidUsd, paper, liquidated } } from papertrade's trade history (paid P&L is after
//     papertrade's cut of winning closes and its win fee); hl: { fills, funding } from Hyperliquid for the
//     hedge over the trade's window, or null when the hedge was on papertrade itself.
// Hyperliquid fill `fee` already includes the builder fee (shown separately as builderUsd).
export function dnCost({ coin, pt, hl }) {
  const legs = Object.values(pt);
  const ptPaid = legs.reduce((a, t) => a + t.paidUsd, 0);
  const paper = legs.reduce((a, t) => a + t.paper, 0);
  let hlPnl = 0;
  let hlFees = 0;
  let builderUsd = 0;
  let fundingUsd = 0;
  if (hl) {
    for (const f of hl.fills ?? []) {
      if (f.coin !== coin) continue;
      hlPnl += Number(f.closedPnl);
      hlFees += Number(f.fee);
      builderUsd += Number(f.builderFee ?? 0);
    }
    for (const u of hl.funding ?? []) if (u.delta?.coin === coin) fundingUsd += Number(u.delta.usdc);
  }
  const net = ptPaid + (hl ? hlPnl - hlFees + fundingUsd : 0);
  return {
    coin,
    venue: hl ? "hl" : "pt",
    legs: legs.length,
    liquidated: legs.some((t) => t.liquidated),
    paper,
    ptPaid,
    hl: hl ? { pnl: hlPnl, fees: hlFees, builder: builderUsd, funding: fundingUsd, net: hlPnl - hlFees + fundingUsd } : null,
    net,
    // positive = what each Paper cost you; negative = you were paid to earn it
    costPerPaper: paper > 0 ? -net / paper : null,
  };
}
