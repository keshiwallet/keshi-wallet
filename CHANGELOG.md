# Changelog

## 1.0.4 - 26 October 2026

Mining: the network at a glance, your miner followed at its pool, and earnings over any period. Safer Buy with USDT, and private swaps on Ethereum. Includes every fix of 1.0.3. Same keys, same addresses, same fees.

Mining
- Pearl network: hashrate, difficulty with its 7-day change, measured block time and the current block reward, read from the wallet's own indexer. The reward follows the node's emission (a slow decay, no halving).
- My miner: follow your payout address at Kryptex or HeroMiners. Hashrate, every worker with its state, unpaid balance at the pool. Only the payout address is sent, which the pool already knows; no account.
- Offline alert: a Chrome notification when a worker stops sending work for 5, 10 or 30 minutes, checked even with Keshi closed or locked, once per outage.
- Earnings by period: 7 days, 30 days, 90 days, 12 months or all time, with a bar per day, week or month; the total since the first payout; and, beyond 7 days, the value at today's price and at the price of each payout.
- Real yield: what you received over the last 7 days against what your hashrate should earn on today's network.
- Pearl mining pools: the main pools with their fee and payout scheme, and a link to each; Peryn (mine PEARL while serving AI requests) is listed as coming.
- Profit calculator: card (Blackwell, Hopper, RTX 50/40/30, reference figures; "estimate" when no public benchmark exists) or your own hashrate and power, every card side by side, electricity price and pool fee; PRL and dollars per day, net after electricity, and the next 30 days with the difficulty growing at its recent pace.
- Offline alerts keep working while Keshi is locked, as long as Chrome runs: the pool and the payout address are kept unencrypted for that, nothing else. The pool is asked every 2 minutes, the chosen delay (5, 10 or 30 min) is the one used, and a worker that disappears from the pool's list is announced too.
- Earnings count mining income only: block rewards and payments to the payout address, not the PRL coming back from the bridge. Real yield is shown only for the payout address of this wallet.
- A new miner can be followed before its first share. Pool requests give up after 15 seconds. The difficulty trend covers exactly 7 days, and the 30-day projection includes the shrinking block reward. "1,200 TH/s" is read as twelve hundred. The unpaid balance follows Hide amounts. On testnet, following a miner is not offered.

Buy with USDT, in two steps
- Your USDT now travels to your own Ethereum address first, then one tap swaps it for wPRL on Uniswap from that address. Keshi reads, inside every transaction it signs, who receives the money: a one-step route hid that in an instruction run on Ethereum after the bridge, which the wallet could not read. Such routes are now refused.
- The ETH for fees is bought with the USDT when your Ethereum address has none, since the swap needs a little.
- At the moment you tap, the swap's price is checked against Uniswap's quote and against Keshi's own PRL price. Keshi's 0.5% stays the only Keshi fee on the purchase; the swap step adds none.
- Keshi signs only LI.FI bridge functions it knows (their first argument is the transfer's description, read at the place the format puts it), never another function shaped to look like one.
- The swap uses only the USDT of this purchase: what LI.FI reports arrived, when it reports USDT on Ethereum, and never more than 3% above the quote. A swap already sent is not sent again while the network still has it.
- Purchases waiting to be swapped are followed for a week, so the "Swap to wPRL" button appears even if you come back the next day.

Ethereum
- Private swaps: swaps go through Flashbots Protect, so bots cannot see a swap coming and trade around it, and a swap that would fail is not included and costs nothing. On by default (Settings > Privacy). If Flashbots does not answer, the swap is not sent. Plain sends, permissions and bridge returns go out the usual way.

Bridge
- A bridge deposit pays exactly the amount the bridge checked: the amount can no longer be changed (or set to Max) on the payment screen.
- The bridge's limits must be read before a deposit; an empty answer is no longer taken as "no limit".

Hardening (October 2026)
- Speed up: a payment sent by an older Keshi, without the record of the coins it spent, is no longer sped up; the network's copy alone is never enough to rebuild a payment.
- Buy with USDT: a quote is signed only if the chain, the amount and the address on screen are still the ones it was asked for; an answer that arrives after the form changed is dropped. LI.FI's permission address must be present and be LI.FI's contract, the quote must name this wallet as the sender, and a negative or unreadable fee is refused.
- Buy with USDT: the purchase is written in the list before it is sent, so it is followed even if the network's answer is lost. A purchase LI.FI reports as finished in a way Keshi does not recognise is shown as "check what arrived", never as "arrived".
- Ethereum: the gas limit never goes above the wallet's ceiling, margin included.
- Release: the store package is built only after the type check and every test pass.

Last checks before release
- The password strength meter and the wallet list look exactly as in 1.0.3 again: two Mining styles had taken their names.
- Buy with USDT: if reading Ethereum failed when the screen opened, "Get a quote" reads it again instead of waiting forever.
- My miner: a malformed entry in the pool's workers list is skipped instead of breaking the whole list (and the alert). A worker with no time of last work is announced only after the chosen delay.
- Private swaps: a swap still waiting is remembered when Keshi is closed and reopened, so the next Ethereum transaction gets the right number; a swap Flashbots gave up on frees its number.
- Removing a wallet stops following a miner at one of its addresses.
- Buy with USDT: if the connection drops while the purchase is sent, it stays in the list and is followed, the quote is cleared so it cannot be signed twice, and the message says to wait before buying again.


Quantum-ready addresses
- Keshi no longer creates them. Pearl removed this address design from its own wallet in pearld 1.5.5, ahead of a different post-quantum address type (P2MR) with its own keys. An address made with an earlier Keshi keeps working: its PRL stay in the balance and are sent as usual, and Settings > Advanced finds it again after restoring the phrase on another device.

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
