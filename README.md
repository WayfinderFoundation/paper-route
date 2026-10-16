<p align="center"><img src="assets/icon128.png" width="96" alt="Paper Route" /></p>

<h1 align="center">Paper Route</h1>

<p align="center">Stop loss, take profit and Hyperliquid hedging for <a href="https://exchange.papertrade.xyz">papertrade</a>, in a Chrome extension. By <a href="https://wayfinder.ai">Wayfinder</a>.</p>

- **Stop loss and take profit** on papertrade, which has neither: set them in the order form or on any open
  position, by price, % return or $. Paper Route watches the price and closes the position for you.
- **Tether**: holds the opposite position on Hyperliquid for exactly as long as your papertrade position exists.
  It shines with large positions riding big moves (see [Where Tether shines](#where-tether-shines)). It follows
  papertrade's *fills*, not your clicks, so queued orders never leave you one-sided.
- **Delta neutral from the order ticket**: hedge on Hyperliquid or with an opposite papertrade position, cover
  25–100 % of it, close both legs together, and see what the trade cost per Paper earned when it closes.
- **Safety net**: if papertrade liquidates a hedged position while your browser is closed, Hyperliquid closes the
  hedge at the same price.
- **Order-flow overlay**: a live read of Hyperliquid's order book and trades, drawn on papertrade's chart.

BTC and ETH. Everything runs in your browser; there's no Paper Route server.

> Papertrade and Hyperliquid are separate venues with real money on both. Nothing here is financial advice.
> Read [Risks](#risks) before you turn anything on.

## Install

Paper Route isn't on the Chrome Web Store yet, so you load it into Chrome yourself. It takes about two minutes.

**1. Download the extension.** Open the [latest release](../../releases/latest) and download
`paper-route-<version>.zip` from **Assets**. Don't use the "Source code" downloads.

<img src="docs/install/1-download.png" width="720" alt="Download paper-route zip from the release assets" />

**2. Unzip it and keep the folder.** Double-click the zip, then move the `paper-route-<version>` folder somewhere
you'll keep it, such as Documents. Chrome runs the extension from this folder, so don't delete it.

<img src="docs/install/2-unzip.png" width="720" alt="The unzipped paper-route folder in Documents" />

**3. Turn on Developer mode.** Open `chrome://extensions` (paste it into the address bar) and switch on
**Developer mode** in the top-right corner.

<img src="docs/install/3-developer-mode.png" width="720" alt="Developer mode switch on chrome://extensions" />

**4. Load the folder.** Click **Load unpacked** (top-left), choose the `paper-route-<version>` folder, the one that
contains `manifest.json`, and click **Select**. Paper Route appears in your extensions list, switched on.

<img src="docs/install/4-load-unpacked.png" width="720" alt="Load unpacked and choose the paper-route folder" />

**5. Pin it.** Click the puzzle-piece icon in Chrome's toolbar, then the pin next to Paper Route. Clicking the
pinned icon opens Paper Route's settings.

<img src="docs/install/5-pin.png" width="720" alt="Pin Paper Route from the extensions menu" />

**6. Open papertrade.** Go to [papertrade](https://exchange.papertrade.xyz/trade/btc) and sign in. The Paper Route
panel appears on the trade page; drag it anywhere, collapse it, or hide it with **Alt+W**.

<img src="docs/install/6-hud.png" width="720" alt="The Paper Route panel on papertrade's trade page" />

## Set up hedging

Click the Paper Route toolbar icon to open its settings, then **1 · Connect Hyperliquid**:

1. Paste the private key of the Hyperliquid wallet you'll hedge with (or pick **Wayfinder API key** and add its
   wallet address).
2. Click **Connect**.

That's it. Paper Route works out the wallet from the key and uses the key once to approve a **trading key** on
your Hyperliquid account (an API wallet that can place orders but **can't withdraw or transfer**), plus the
builder fee. Then it forgets your key: nothing that can withdraw is saved. You'll only paste the key again to
send USDC from Hyperliquid to papertrade, or to reconnect after 180 days. Your papertrade account is picked up
from the one you're signed in to on papertrade. The two can be the same wallet.

Back on papertrade, pick the Hyperliquid leverage in the panel, then turn on **Tether** (connecting turns it on for you)
and place trades on papertrade's order ticket as usual.
If a trade is too small for papertrade's minimum, the panel says what to change (usually a higher Hyperliquid
leverage, or more USDC).

BTC and ETH are hedged at the same time, each on its own: its own Tether switch, Hyperliquid leverage and
safety net. The papertrade page you're on only decides which coin the panel shows in full; the other coin gets a
one-line status underneath. Connecting turns Tether on for both.

## Keep it running

Tether, stop losses and take profits run **in your browser**. While any of them is active:

- **Keep Chrome open and Paper Route enabled.** The toolbar icon shows **ON** and the panel shows an amber banner
  while Paper Route is responsible for positions.
- **Tether works without the papertrade tab** as long as Chrome is open: it watches papertrade's account and your
  Hyperliquid account from the extension's background.
- **Papertrade-venue delta neutral needs a papertrade tab**: the hedge leg is placed through papertrade's order
  ticket, and closing a pair clicks papertrade's Close buttons.
- **If Chrome is closed, the laptop sleeps or the extension is off, nothing is watched.** Both legs stay open, so
  you remain hedged, but nothing rebalances. If papertrade liquidates the position meanwhile, the
  [safety net](#safety-net) closes the hedge on Hyperliquid at the same price.

## Update

1. Download the new release zip and unzip it. Replacing the old folder is tidiest.
2. In `chrome://extensions`, click the reload icon on Paper Route. If you unzipped to a new folder, remove the old
   copy and **Load unpacked** the new one instead.
3. Refresh papertrade.

The extension ID is fixed, so your encrypted key, trading key, settings and TP/SL levels carry over either way.
Don't load two versions at once.

## Features in detail

### Tether

#### Where Tether shines

Every hedge is a Hyperliquid market order on the way in and again on the way out, each paying Hyperliquid's taker
fee and the builder fee. That's worth it when the position is **large** and the move is **big**: then the hedge
does real work. On small positions or quick in-and-out trades, the fees may offset any gains.

#### Earning Paper with a hedge

Papertrade pays out **Paper** when you lose: a losing close or a liquidation mints it (a liquidation on the full
margin). With Tether holding the opposite position on Hyperliquid, a papertrade loss is matched by a Hyperliquid
gain of about the same size, so you collect Paper while your dollars stay roughly where they were, before fees.
With Tether on, the stop loss / take profit fields are set up for this (see below), and the HUD's Order flow
points to the papertrade side that's likelier to lose.

#### How it follows papertrade

Papertrade takes a fee on winning trades and none on losses, so the leg you hold there is the one you'd rather
lose with. Paper Route holds the opposite position on Hyperliquid, so the pair is market-neutral. Papertrade
**queues** opens and closes, sometimes for minutes, so the hedge reacts to papertrade **fills**, never to clicks:

- a queued papertrade open is not a position yet, so Hyperliquid waits for it to land;
- a queued papertrade close keeps you exposed, so the Hyperliquid leg stays on until the close fills;
- if the hedge drifts by more than your band (e.g. you trade papertrade by hand), it trues it up.

### Delta neutral (order ticket)

Papertrade's order ticket gets a **Delta neutral** block above TP / SL:

It starts on **Papertrade at 100 %**, which needs no Hyperliquid wallet (if you already use Tether on a coin, that
coin shows Hyperliquid).

- **Hedge on: Hyperliquid** is Tether: Hyperliquid opens the opposite side when papertrade fills and closes it
  when papertrade closes.
- **Hedge on: Papertrade** places an opposite papertrade order together with yours (same leverage). Both wait in
  papertrade's queue, so they can fill at different times and prices; Paper Route pairs them once both fill.
- **Coverage** (25 / 50 / 75 / 100 %) sets how much of the position the hedge covers.
- **Close both** appears while a hedged position is open.
- **Auto close both legs** (in TP / SL, on by default): a stop loss or take profit closes both legs, and if one leg
  of a papertrade pair closes or is liquidated the other is closed too. Off: only the papertrade position closes
  and the hedge is left to run (with Hyperliquid, Tether is switched off for that coin so it isn't unwound).

Papertrade closes whole positions only, so there are no partial trims.

**Cost per Paper.** When a delta-neutral trade finishes, a toast shows what it cost per Paper earned: papertrade's
paid P&L for every leg (after its cut of winning closes) and the Paper it minted, plus for a Hyperliquid hedge
that hedge's P&L, fees (including the builder fee) and funding over the trade. It only appears for a complete
exit: both legs of a papertrade pair closed, or papertrade flat on that coin with the Hyperliquid hedge unwound.
The numbers come from papertrade's trade history and Hyperliquid's own fill and funding records; any other trading
on the same coin in the hedge wallet during the trade is counted too.

### Stop loss and take profit

Papertrade has no stop or take-profit orders, so Paper Route adds them where you'd expect:

- **In the order form:** tick **TP / SL** under Bust Price. Each side has a price box and a gain/loss box
  (% return on margin, or $), linked so typing one fills in the other, plus quick picks. The levels attach to the
  position when papertrade fills the order; % and $ targets are worked out from the actual fill price.
- **On any open position:** the **TP/SL** chip on the row opens an editor for that position. Each position has
  its own levels, and they're drawn on the chart.

These levels are **not placed on papertrade**. Paper Route watches Hyperliquid's mid (which papertrade tracks to
under 1 bp) and, when a level is hit, clicks papertrade's own Close button, following papertrade's queue. With
Tether on, the Hyperliquid hedge closes when that close fills. A level is a trigger, not a price guarantee, and it
only works while Chrome is open with Paper Route enabled (see [Keep it running](#keep-it-running)).

**With Tether on, the exits are set up for [earning Paper with a hedge](#earning-paper-with-a-hedge).** The papertrade leg is meant to lose, since
losing closes and liquidations mint PAPER (a liquidation on the full margin), so the form and editor show a
**Tether on** pill and relabel the two sides:

- **Win exit (TP)** (the take-profit side): an early exit, off by default. A winning close earns
  no PAPER, and while hedged the pair stays neutral if you wait.
- **Bank Paper at (SL)** (the stop-loss side): close both legs once papertrade is down 25 / 50 / 75 % of
  margin, or **At bust** (the default) to let papertrade liquidate while the [safety net](#safety-net) closes
  Hyperliquid at the same price.

With Tether off the pill reads **Tether off** and they work as an ordinary one-sided take profit and stop loss.
The amount next to each side shows the dollar P&L and how far price has to move: picks are a % of your margin,
so the dollars stay the same at any leverage while the distance shrinks as leverage rises.

### Safety net

Papertrade liquidates a position by itself, browser or not. So that the hedge doesn't outlive it, Paper Route
rests one reduce-only trigger order on Hyperliquid per hedged papertrade position, at that position's liquidation
(bust) price and for its size. If papertrade busts while Chrome is closed, Hyperliquid closes the matching hedge
at the same price. The orders are kept in step as positions open, resize and close, and only orders Paper Route
placed are ever changed. It's on by default (Settings → Safety net).

### Sizing and balances

Before you place a papertrade order, the panel warns if Hyperliquid couldn't hedge it: not enough free margin at
your chosen Hyperliquid leverage, or over the optional max hedge you can set in settings (no cap by default). Big
hedges go out as several orders of at most the order chunk (default $50K) one after another, so no single order
moves the price much. Before each hedge Paper Route also checks the target against papertrade's own margin ×
leverage for that coin and sends nothing if they disagree.

The panel shows live P&L for both legs (papertrade after its win fee), papertrade bust vs Hyperliquid liquidation
distance, and a rebalance suggestion that keeps Hyperliquid's liquidation a set multiple further away than
papertrade's bust. One click sends USDC from Hyperliquid to your papertrade deposit address.

### Order-flow overlay

A panel and chart layer built only from Hyperliquid's public websocket (order book, trades, open interest,
funding): the components (book imbalance, top-of-book queue size and change, order-flow imbalance, taker flow,
momentum, open-interest change, mark vs mid), a volatility regime, and a combined **order-flow index** with its expected move over the
next 10 s to 2 minutes drawn on the chart. The lean is grey below an index of 40, a softer colour from 40 and
full colour from 60 ("strongly"), and dimmed in a wild market, where calls are least reliable. The HUD says which way price leans over that window; with Tether on it also
names the papertrade side that's likelier to lose (see [Earning Paper with a hedge](#earning-paper-with-a-hedge)).
See [Does it work?](#does-it-work) for how much that's worth. The chart also shows
papertrade's bust price and Hyperliquid's liquidation price.

### Fees

Hedge market orders on Hyperliquid carry Wayfinder's builder fee of **0.02 %** of order notional (2 bp), on top
of Hyperliquid's own trading fee, so a hedge that opens and closes pays it twice. You approve it once (capped at
0.02 %); you can switch it off in settings.

## Build from source

```bash
git clone https://github.com/WayfinderFoundation/paper-route.git
cd paper-route
npm ci
npm run build          # dev build into dist/; load the repo folder unpacked (auto-reloads on file changes)
npm test               # offline tests: per-coin Tether, TP/SL, safety net, order idempotency, flow features
npm run build:release  # release/paper-route-<version>.zip (refuses to package anything that looks like a key)
```

To run your own build, load the repo folder with **Load unpacked** as in [Install](#install) step 4. To update it:
`git pull && npm ci && npm run build`, then reload the extension.

Releases are built by GitHub Actions from a `v*` tag that matches `manifest.json`'s version.

## Does it work?

The order-flow index is two small linear models, fitted to predict the BTC Hyperliquid mid's move over the next
10, 30, 60 and 120 seconds. Each forecast is `intercept + Σ weight × (feature − mean) / sd`.

- **Quick model**, used from 10 seconds after the page connects. It needs only a few seconds of history.
- **Full model**, used from 60 seconds on. It takes over as soon as its features have a minute of data.

Full model:

| Feature | What it measures | Weight per 1 sd (10 / 30 / 60 / 120 s, bp) |
|---|---|---|
| `l1_rel_imb` | Best bid queue vs its last minute, minus the same for the best ask | +0.27 / +0.29 / +0.28 / +0.27 |
| `imb5` | Size imbalance over the top 5 book levels | +0.16 / +0.26 / +0.31 / +0.35 |
| `ofi_1s` | Order-flow imbalance at the top of the book over 1 s | +0.11 / +0.09 / +0.09 / +0.08 |
| `l1dq_2s` | How fast the best bid queue grows, or the best ask queue is eaten, over 2 s | +0.09 / +0.10 / +0.11 / +0.11 |
| `ofi_30s` | Order-flow imbalance at the top of the book over 30 s | +0.04 / +0.06 / +0.07 / +0.03 |

The quick model uses the top-of-book imbalance, the top-10 imbalance, its 2 s change, and 1 s / 5 s order-flow
imbalance normalised by the last 10 s of top-of-book size.

Taker flow, momentum, open interest, funding, mark and oracle vs mid, how recently the oracle updated, trade-tape
shape, and small nonlinear models (a GAM, a small neural net, a small TCN, a capped gradient-boosted model) were
also tested. The nonlinear models added at most about +0.01 IC at 10 s, and nothing once you allow for acting
2 s later, so the index stays linear.

**BTC, fitted on 87 days (2026-07-04 to 09-28), scored on the next 14 days it never saw (09-29 to 10-12),
1.1 M one-second samples.** IC is the correlation between the expected move and what happened next. The
brackets are 95 % confidence intervals from resampling whole days.

| Horizon | IC | IC if you act 2 s later | Quick model IC | Top-decile mean move | Sign right (non-zero moves) |
|---|---|---|---|---|---|
| 10 s | 0.30 [0.28, 0.31] | 0.16 [0.15, 0.18] | 0.28 | +0.95 bp | 72 % |
| 30 s | 0.20 [0.18, 0.21] | 0.12 [0.10, 0.14] | 0.19 | +1.07 bp | 63 % |
| 60 s | 0.14 [0.13, 0.16] | 0.09 [0.08, 0.11] | 0.14 | +1.07 bp | 59 % |
| 120 s | 0.11 [0.10, 0.12] | 0.07 [0.06, 0.09] | 0.11 | +1.07 bp | 57 % |

Training rows are rebuilt exactly as the browser sees the market: the top of the book from Hyperliquid's
best-bid/offer feed, which updates several times a second, and deeper levels from its slower full-book feed. On
those rows the previous seven-feature index scored 0.24 at 10 s. On the first day after the holdout
(2026-10-13), the 10 / 30 / 60 / 120 s IC was 0.30 / 0.19 / 0.15 / 0.11.

The volatility regime uses the 10-minute realised volatility of 1 s returns (calm < 0.25 bp, wild ≥ 0.42 bp). By
regime, the 10 s IC is 0.36 calm, 0.37 normal and 0.26 wild. It's weakest when markets move fast, which is also
when acting late costs the most.

What this means in practice:

- **It's real but small.** Even the strongest decile expects about 1 bp, well inside a taker round trip on
  Hyperliquid, so it doesn't pay for itself as a standalone strategy. Read it as a lean (which way the next few
  ticks are likelier to go), not as a trading signal.
- **Speed matters.** Much of the 10 s skill is the next tick, and acting 2 s late removes about half of it.
- **ETH is provisional.** There's only about a day of ETH order-book history so far, so ETH uses BTC's weights
  re-scaled to ETH's own feature ranges. On that day its 10 / 30 / 60 / 120 s IC was 0.25 / 0.16 / 0.12 / 0.10.
  The HUD marks ETH as provisional until it has its own fit.
- **Start-up:** forecasts start 10 s after the page connects and switch to the full model at 60 s. Only the
  volatility regime label needs 10 minutes of data. The feed restarts only after 10 s with no message at all;
  shorter stalls carry the last book forward.

Every feature is computed in your browser exactly as in the fit. `test/parity.mjs` replays 20 minutes of
recorded 100 ms ticks through the extension's engine. It matches the fit's features and both models'
forecasts at every horizon to about 1e-6. Formulas are at the top of `src/flowindex.js`; weights are in
`src/index-weights.json`.

## How it works

| File | Role |
|---|---|
| `src/hedge.js` | Hedge engine: one Tether lane per coin over a shared papertrade stream and Hyperliquid account read; rebalancing, key handling |
| `src/exits.js` | Stop loss / take profit watcher (closes through papertrade's Close button) |
| `src/pairs.js` | Delta-neutral pairs on papertrade: pairs the two fills, closes them together (auto close) |
| `src/dncost.js` | Cost per Paper of a finished delta-neutral trade |
| `src/safetynet.js` | Plans the reduce-only orders at papertrade's liquidation prices |
| `src/papertrade.js` | Papertrade public endpoints: account stream, trading limits, open-interest room, win fee, deposit address |
| `src/hl.js` | Hyperliquid client: idempotent orders (cloid + status check), leverage, transfers, approvals |
| `src/market.js`, `src/flowindex.js` | Hyperliquid websocket → order-flow features and index (pure, tested) |
| `src/vault.js` | Passphrase-encrypted key storage (non-extractable device key + AES-GCM) |
| `content.js`, `hedge-ui.js` | HUD and chart layer; papertrade orders go through papertrade's own ticket and Close buttons |
| `tpsl-ui.js` | Delta neutral and TP / SL blocks in papertrade's order ticket, TP/SL chips on positions, the cost toast |
| `chart-bridge.js` | Reads papertrade's chart price/time mapping from its canvas draws (it has no public chart API) |

Papertrade has no trading API you can sign for, so a stop loss or take profit closes the position by clicking
papertrade's own Close button in your signed-in tab (Paper Route opens one if none is open), and a delta-neutral
hedge on papertrade is placed through its own order ticket right after your order. Each click uses an element
only if exactly one matches, and a page self-check warns if papertrade's page changes. Tether only trades
Hyperliquid, so it needs no papertrade tab.

## Risks

- **Papertrade queue.** Opens and closes can wait minutes. While a close is queued you hold both the papertrade
  side and the hedge, so you stay neutral until it fills.
- **Safety-net edge cases.** Hyperliquid triggers on its mark price, papertrade busts on Hyperliquid's mid at its
  block time. At the very edge one can happen without the other; with Chrome open, Tether re-hedges
  straight away, with Chrome closed the pair stays one-sided until you're back.
- **Liquidation mismatch.** Papertrade busts at about `1/leverage` from entry; Hyperliquid liquidates at its own
  margin level. Keep Hyperliquid's liquidation well beyond papertrade's bust (the HUD shows both and a
  suggested balance).
- **Browser dependence.** Hedging runs in your browser. See [Keep it running](#keep-it-running).
- **Keys.** Your wallet key isn't stored. The trading key is kept in the extension (sealed to this browser); it
  can trade on your Hyperliquid account but can't withdraw. Revoke it on Hyperliquid's API page if needed.
- **Delta neutral on papertrade.** Both legs wait in papertrade's queue, so they can fill at different times and
  prices, and papertrade keeps part of every winning close while losses are paid in full, so a pair costs money
  over time (the cost toast shows how much per Paper). At high leverage one leg can be liquidated; with auto close
  the other is closed straight after.
- **Index.** The order-flow index is a short-horizon statistical lean, not a signal that covers fees on its own.

## License

MIT
