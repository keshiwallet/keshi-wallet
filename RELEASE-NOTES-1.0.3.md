## Keshi 1.0.3

Buy PRL with USDT from another chain, your PRL at a glance, and a clearer review before you confirm. Nothing from 1.0.2 changes: same keys, same addresses, and the existing fees stay as they were.

The extension is now listed as **Keshi Wallet for Pearl** in the Chrome Web Store. Exchanges now list Pearl as PEARL (formerly PRL); Keshi reads both names, and still writes PRL in the app.

**Buy with USDT**
- Buy now has two tabs, "Buy with USDT" (Arbitrum, BNB Chain, Polygon) and "Exchange" (SafeTrade, BigONE, Uniswap). With USDT, your USDT on one of those chains becomes wPRL on your Ethereum address in Keshi, through LI.FI, in a few seconds and without an exchange account. Keshi never holds the money: you sign on the source chain, LI.FI's contracts bridge and swap, and the same address receives on Ethereum.
- A quote shows what you receive, the floor you accept, every fee (Keshi's 0.5% included) and your balances before and after. An optional second purchase buys a little ETH for the return to PRL through the bridge: it is a separate transaction (with its own permission and fee), sent once the first is confirmed.
- Each purchase is followed until LI.FI reports how it ended, and that outcome is kept (arrived, partly arrived, refunded or failed); then Bridge brings the wPRL home as PRL.
- Purchases and bridge crossings are listed per account: switching accounts no longer shows another account's records.
- A three-step "How it works" card the first time, a rough PRL figure under the amount, and a short note when the amount is small enough for the fixed costs of the trip to PRL (ETH for the bridge fee, LI.FI's route, PearlBridge's minimum of 4 PRL) to weigh more than 5%.

**Home**
- The Ethereum side (ETH, wPRL) shows on the home screen from the first open, also after restoring a phrase. This reads the wallet's Ethereum address from public Ethereum servers; Settings > Privacy > "Check Ethereum automatically" turns it off.

**Safety**
- Buy with USDT: the wallet reads the recipient and destination chain inside the transaction LI.FI prepares, and refuses anything that is not your own address on Ethereum, whatever the quote says.
- The two-step setup key is cleared from the clipboard 30 seconds after you copy it.
- Buy with USDT: the quote must spend exactly the USDT you typed, the amount written inside LI.FI's transaction may not exceed it, and the price is checked against Keshi's own price feed (no feed, no signature).
- Speed up: a waiting payment is rebuilt only from the coins this device approved, never from the network's copy of it.
- A connected site can ask to sign or pay only right after you click on it, and not again for a minute after a refusal.
- With the balance hidden, the "PRL received" notification no longer shows the amount.

**PRL screen** (tap PRL under Your assets)
- Your PRL over time: the value of what you held over 7, 30 or 90 days, at the price of each moment. Worked out from this wallet's own payments, so no new data leaves the wallet.
- Watched addresses: follow any Pearl address without its keys (a mining payout address, a cold wallet). Balance only; nothing can be spent from Keshi, and these coins stay out of your total.

**Release**
- The store zip is reproducible (fixed file dates and order), and GitHub rebuilds and verifies every push (Actions tab, "Rebuild and verify").

**Before you confirm**
- Every review shows your balance before and after: PRL on Send, Combine payouts and Bridge; wPRL and ETH on Swap, Bridge back and Ethereum sends.

**Check it yourself**

```
npm ci
npm run build
node verify.mjs
```

`All 17 files match Keshi 1.0.3.` means this code makes the files of the Store package.

`keshi-chrome-1.0.3.zip` (attached) is the package uploaded to the Chrome Web Store.
SHA-256: `f2df45c95d4975e210ea7d4aa801dd20e67aa6e954afa98f722d25a715a03604`
