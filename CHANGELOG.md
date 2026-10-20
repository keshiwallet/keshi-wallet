# Changelog

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
