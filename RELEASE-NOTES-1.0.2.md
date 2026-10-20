## Keshi 1.0.2

The version now in the Chrome Web Store.

**Accounts**
- Several accounts on one recovery phrase (Settings > Wallets > Add an account), each with its own addresses, history and Ethereum address.
- Restoring a phrase brings back the accounts it already used.
- Remove a wallet from Keshi, with your password.

**Safety, after an outside code review**
- "Best price" walks each exchange's order book for your amount. Keshi no longer places exchange orders with an API key.
- Testnet: Buy and Sell are off; the network is named on every payment review.
- A figure Keshi could not read is shown as unknown, never as zero.
- A restored phrase is not looked up on Ethereum until you use an Ethereum feature.
- Bridge: clearer review, warnings on small crossings, risky destinations refused or confirmed.

**Other**
- SafeTrade renamed PRL to PEARL: prices, charts and Best price keep working on SafeTrade and BigONE.

**Check it yourself**

```
npm ci
npm run build
node verify.mjs
```

`All 17 files match Keshi 1.0.2.` means this code makes the files of the Store package.

`keshi-chrome-1.0.2.zip` (attached) is the package uploaded to the Chrome Web Store.
SHA-256: `61d7b9502396fc48d823b34e6d8e9226ac62f32bc810d388734441f3cdb2c3d1`

Keshi is independent (not made by Pearl Research Labs) and has not been audited by a firm yet: start with a small amount.
