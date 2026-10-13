# Installing Paper Route

1. Unzip this folder somewhere permanent (e.g. `~/Extensions/paper-route`). Chrome loads the extension from
   here, so don't delete it.
2. Open `chrome://extensions`, switch on **Developer mode** (top right) and click **Load unpacked**. Pick this
   folder (the one containing `manifest.json`).
3. Pin Paper Route from Chrome's puzzle-piece menu and click it to open the settings:
   - **Hedge wallet**: your Hyperliquid address.
   - **Main key**: the Hyperliquid account's private key (or a Wayfinder API key), with a passphrase.
   - **Create trading key**: an API wallet that can trade but can't withdraw.
4. Open https://exchange.papertrade.xyz/trade/btc (or `/trade/eth`), sign in, and use the HUD.

## Keep it running

Stops, take profits, scheduled rounds and Tether run in your browser, not on papertrade or Hyperliquid. While the
toolbar icon shows **ON**, keep Chrome open and Paper Route enabled. The papertrade tab may be closed: Paper Route
reopens it in the background when it needs to close or open something.

## Updating

Unzip the new release, then click the reload icon on Paper Route in `chrome://extensions` (or remove the old copy
and Load unpacked the new folder). Your keys, settings and rounds carry over. Refresh papertrade afterwards.

Full guide, fees, risks and how the hedge follows papertrade's queue:
https://github.com/WayfinderFoundation/paper-route
