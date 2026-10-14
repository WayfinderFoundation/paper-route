# Installing Paper Route

1. Unzip this folder somewhere permanent (e.g. `~/Extensions/paper-route`). Chrome loads the extension from
   here, so don't delete it.
2. Open `chrome://extensions`, switch on **Developer mode** (top right) and click **Load unpacked**. Pick this
   folder (the one containing `manifest.json`).
3. Pin Paper Route from Chrome's puzzle-piece menu and click it. Under **1 · Connect Hyperliquid**, paste the
   private key of the Hyperliquid wallet you'll hedge with and click **Connect**. Paper Route sets up a trading
   key (trades, can't withdraw) and forgets your key.
4. Open https://exchange.papertrade.xyz/trade/btc (or `/trade/eth`), sign in, and use the HUD.

## Keep it running

Stop losses, take profits and Tether (BTC and ETH at once) run in your browser, not on papertrade or Hyperliquid. While the
toolbar icon shows **ON**, keep Chrome open and Paper Route enabled. The papertrade tab may be closed: Paper Route
reopens it in the background when it needs to close something.

## Updating

Unzip the new release, then click the reload icon on Paper Route in `chrome://extensions` (or remove the old copy
and Load unpacked the new folder). Your keys, settings and TP/SL levels carry over. Refresh papertrade afterwards.

Full guide, fees, risks and how the hedge follows papertrade's queue:
https://github.com/WayfinderFoundation/paper-route
