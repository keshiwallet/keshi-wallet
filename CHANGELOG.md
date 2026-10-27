# Changelog

## 1.0.3 - 22 October 2026

Buy PRL with USDT from another chain, your PRL at a glance, and a clearer review before you confirm. Nothing from 1.0.2 changes: same keys, same addresses, same fees.

Buy with USDT
- Buy now has two tabs, "Buy with USDT" (Arbitrum, BNB Chain, Polygon) and "Exchange" (SafeTrade, BigONE, Uniswap). With USDT, your USDT on one of those chains becomes wPRL on your Ethereum address in Keshi, through LI.FI, in a few seconds and without an exchange account. Keshi never holds the money: you sign on the source chain, LI.FI's contracts bridge and swap, and the same address receives on Ethereum.
- A quote shows what you receive, the floor you accept, every fee (Keshi's 0.5% included) and your balances before and after. An optional second purchase buys a little ETH for the return to PRL through the bridge: it is a separate transaction (with its own permission and fee), sent once the first is confirmed.
- Each purchase is followed until LI.FI reports how it ended, and that outcome is kept (arrived, partly arrived, refunded or failed); then Bridge brings the wPRL home as PRL.
- Purchases and bridge crossings are listed per account: switching accounts no longer shows another account's records.
- A three-step "How it works" card the first time, a rough PRL figure under the amount, and a short note when the amount is small enough for the fixed costs of the trip to PRL (ETH for the bridge fee, LI.FI's route, PearlBridge's minimum of 4 PRL) to weigh more than 5%.

Home
- The Ethereum side (ETH, wPRL) shows on the home screen from the first open, also after restoring a phrase. This reads the wallet's Ethereum address from public Ethereum servers; Settings > Privacy > "Check Ethereum automatically" turns it off.

Safety
- Buy with USDT: the wallet reads the recipient and destination chain inside the transaction LI.FI prepares, and refuses anything that is not your own address on Ethereum, whatever the quote says.
- The two-step setup key is cleared from the clipboard 30 seconds after you copy it.
- Buy with USDT: the quote must spend exactly the USDT you typed, the amount written inside LI.FI's transaction may not exceed it, and the price is checked against Keshi's own price feed (no feed, no signature).
- Speed up: a waiting payment is rebuilt only from the coins this device approved, never from the network's copy of it.
- A connected site can ask to sign or pay only right after you click on it, and not again for a minute after a refusal.
- With the balance hidden, the "PRL received" notification no longer shows the amount.

PRL screen (tap PRL under Your assets)
- Your PRL over time: the value of what you held over 7, 30 or 90 days, at the price of each moment. Worked out from this wallet's own payments, so no new data leaves the wallet.
- Watched addresses: follow any Pearl address without its keys (a mining payout address, a cold wallet). Balance only, nothing can be spent, and watched addresses count as "known" for the look-alike warning.


Release
- The store zip is reproducible (fixed file dates and order), and GitHub rebuilds and verifies every push (Actions tab, "Rebuild and verify").

Before you confirm
- Every review now shows your balance before and after: PRL on Send, Combine payouts and Bridge; wPRL and ETH on Swap, Bridge back and Ethereum sends.

## 1.0.2 - 20 October 2026

Accounts, and safety work after an outside code review. This is the version in the Chrome Web Store.

Accounts
- A recovery phrase can now hold several accounts: Settings > Wallets > Add an account. Each account has its own addresses, history and Ethereum address.
- Restoring a phrase also brings back the accounts it already used on the network.
- A wallet can be removed from Keshi (Settings > Wallets > Remove), with your password.

Safety
- Testnet: Buy and Sell are off, like Swap, Bridge and Mint, and the network is named on every payment review.
- Exchanges: "Best price" walks each order book for your amount and says when a book is too thin. Keshi no longer places orders with an exchange API key: you trade on the exchange's own site.
- When the token index cannot be reached, coins already known to carry tokens stay protected, and sending asks for your explicit go-ahead.
- A figure Keshi could not read is shown as unknown, never as zero.
- A restored phrase is not looked up on Ethereum until you open Swap, Bridge or Receive ETH.
- Bridge: the review shows what you pay, what you receive and one Fees line, and warns when fees are a large share of a small crossing. The zero address and known contracts are refused; a smart-contract destination asks for your go-ahead.
- A new wallet made from Settings > Wallets is written down and checked before it is saved.
- Token and inscription sends get the same recipient notices as payments.

Other
- SafeTrade renamed the coin from PRL to PEARL: Keshi finds the pair under either name, on SafeTrade and BigONE.
- ETH is always listed once the Ethereum side is on, and a tiny balance shows its first digits instead of 0.00000.
- Clearer wording on what Two-step unlock protects.

## 1.0.1 - 14 October 2026

Security and polish update. This is the version in the Chrome Web Store.

- Speed up: Keshi now measures the payment itself to work out the higher fee, instead of trusting the size reported by the network server.
- "Show recovery phrase" and the settings that ask for your password: the same delay after wrong passwords as the unlock screen.
- Sign message: a warning when the text names a different website than the one asking, so a sign-in meant for another site is not signed by mistake.
- QR codes are drawn as images.
- New support address: contact@keshiwallet.com.

## 1.0.0 - 8 October 2026

First public release.

- Self-custody wallet for Pearl: create, restore (12 or 24 words, Pearl Research Labs wallet phrases included) or import from a private key.
- Send and receive PRL, speed up a pending payment, saved addresses.
- Buy and sell PRL with BigONE, SafeTrade or Uniswap, compared for your amount.
- Swap wPRL and ETH on Uniswap.
- Bridge PRL to Ethereum and back with PearlBridge.
- PRL-20 tokens: browse and mint.
- Mining rewards tracking and payout combining.
- Explore tab with Pearl and Ethereum news from the largest crypto newsrooms, each story once, marked bullish or bearish.
- Several named wallets, auto-lock, optional authenticator code, testnet mode.
