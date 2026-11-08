# Changelog

## 1.0.5 - 6 November 2026

Peryn, PearlHash, Pearl Fortune and LuckyPool in the Mining tab, followed like the other pools, a dot next to each pool that answers, Connect details and the cost after luck of each pool, a hashrate alert, and an EIP-7702 warning on Ethereum. Nothing else changes: same keys, same addresses, same fees.

Mining
- Peryn can be followed like Kryptex and HeroMiners, from its documented API (docs.peryn.ai, app.peryn.ai/api/v1): every worker, who is online as Peryn counts it (an accepted share in the last few minutes), the balance owed, and a notification when a worker stops, even with Keshi closed or locked. Only the payout address is sent, no account. The pool line shows what Peryn reports: hashrate, miners, payouts every 2 hours from 1 PRL, and its fee (1% on PPS+, the default, and on PPLNS).
- PearlHash can be followed too, from the page its site reads for one address (pearlhash.xyz/api/account): the workers connected right now, the hashrate, the balance as the sum of its movements, and a notification when a worker leaves the list. Its line shows the pool's hashrate and accounts from pearlhash.xyz/api/stats; the fee is as PearlHash announces it (1%). "Open PearlHash" opens that address's own page on the pool.
- Pearl Fortune can be followed as well, from the pages its Address Lookup reads (pearlfortune.org/api/v1): the rolling hashrate, the workers connected, the balance from the ledger, and the fee of the address's own payment mode (2% PPLNS or 4% PPS, as the pool reports them). Its line shows the pool's hashrate and blocks found in 24 hours.
- LuckyPool can be followed as well, from the pages its "Your stats" reads (pearl.luckypool.io/api): hashrate, 24-hour average, workers, balance (unlocked and locked) and paid, with the pool's fee; its line shows its hashrate, miners and 2-hourly payouts from 1 PRL, and its last two days of blocks give the luck. Connect lists its 19 servers, the three ports by rig size, solo and Nockchain merge-mining formats.
- "My miner" also shows the 24-hour average hashrate (Peryn, HeroMiners, Pearl Fortune, LuckyPool) and what the pool has paid so far (Peryn, HeroMiners, LuckyPool, Kryptex, PearlHash), when the pool reports them. Peryn's line shows its Founding Miners rate as Peryn announces it.
- Pools guide corrected from the pools' own pages. AlphaPool is no longer listed. The pool chooser in "My miner" has six pools on two rows.
- Pool status: a green dot next to each of the six pools when the pool's page answered Keshi just now, a grey one when it did not (which can be the pool, the network or this computer, so it is not called "offline"). Asked when the Mining tab opens and once a minute while it stays open. 
- Connect, next to Follow on every pool that can be followed: the pool's addresses by region (with the TLS port), your username with the worker name filled in, the password the pool asks for, each with a Copy button, a dot for the pool and, at Peryn, a dot per server as the pool reports it. Only what a miner needs to start is shown (the four nearest servers); More unfolds the other servers, one command line for the miner the pool documents first, and the pool's options, and a button opens the pool's own setup guide. The addresses are as each pool's site lists them, not read from the network, so the pool's guide (linked) is the reference if one moves.
- "Cost after luck" per pool: the fee the pool reported just now, plus how the pool's luck ran for everyone (blocks found against blocks its hashrate should have found) for PPLNS and PROP pools that publish their blocks (HeroMiners from its own 7-day effort, Pearl Fortune over a week, LuckyPool from its own 7-day effort, or its last two days of blocks when that page is missing). PPS and PPS+ pools pay per share, so their cost is their fee. It is a past, pool-wide figure, not a charge and not a promise of your own yield; a pool that did not report its fee gets no figure (the guide's range is never used as a number). Shown as "—" when the pool's hashrate should have found fewer than 20 blocks over the window, because the figure would be noise.
- What your hashrate would earn per day at each pool, fee taken, once you follow a miner: the same network figures as the profit calculator, pool by pool.
- A hashrate alert next to the offline alert: when a worker still mines but sits under 60% of its usual hashrate on two checks in a row (a card dropped out, a rig throttled), one notification however many workers it concerns, and another only after they are back over 80%. The usual hashrate is learned over the first readings; a worker connected less than 30 minutes ago, or one climbing back after a restart, is never a drop.
- A worker that leaves a pool's list of connected workers (PearlHash and Pearl Fortune list only those) is announced after the chosen delay, like an idle one: a reconnection that straddles a check is not a stop. Every worker of a farm, however many, is watched by the alerts; the screen lists the first thousand. A pool's answer is cut off at 4 MB before it is parsed, and every amount, name and list in it is bounded before it is read: a hostile or runaway answer is dropped, not waited for. A worker list the pool failed to send is "unknown", never an empty list, so no worker is reported stopped from a failed request.
- HeroMiners hashrates are read in the pool's unit (2^32 hashes): a followed miner showed a few kH/s instead of its real TH/s or PH/s before. Its pool fee is read for the real-yield figure, its line shows its real hashrate, miners and hourly payout, and its own 7-day effort gives the luck behind the real cost. Kryptex's line shows its hashrate, miners and minimum payout as its pool page reports them.
- Kryptex workers are read as Kryptex really answers (avg_hashrate_30m, status, last_share in milliseconds): they showed 0 H/s and offline before. A farm's thousands of workers all count in the totals. Connect for Kryptex writes the username as the pool does, wallet/worker, and lists its Russia server. HeroMiners' 15 servers as its site lists them, its PROP scheme, hourly payouts from 1 PRL, and a 0% fee read as such when the pool states it.
- Kryptex's fee is read as the pool reports it (a fraction, "0.03" for 3%): it showed as 0.03% before. The same reading feeds the real-yield figure.
- After an independent review of the whole 1.0.5 candidate (6 November 2026), beyond the pool code: a LI.FI transaction that swaps on the source chain before bridging is now read in full at that level — the swaps must start from exactly the USDT entered, taken from the user, feed one another, end in the token the bridge sends, and never call the USDT contract itself; a plain bridge call must bridge that USDT; a function announcing a swap it does not carry (or the reverse) is refused. What Keshi still cannot read, and says so: the bytes each swap hands to its exchange, and the bridge's own arguments. The second step of a USDT purchase swaps only what Ethereum itself shows delivered to the buyer's address by the transaction LI.FI names (its Transfer event), never a server's figure; without that, the swap is capped at the quote and the screen says the amount is not verified. If the LI.FI step fails after the permission step, the message says that the permission (exact amount, LI.FI's contract only) stays until a purchase uses it. Before any Ethereum transaction, the server must answer `eth_chainId` with the chain being signed for, and an address that delegates to a contract (EIP-7702) is refused on every Ethereum action, not only warned about on one screen. A site's connection is good only for the wallet and network it was given on. A Flashbots send that got no answer is reported as not confirmed (its number kept), not as "nothing was swapped". Quotes and checks (swap, bridge, token mint, home balances) are dropped when the form or wallet changed before they came back, and the bridge's figures are read again right before going on. Pool and news answers are cut off at 4 MB / 2 MB before parsing; a worker list a pool failed to send is "unknown", never empty; a pool answer with nothing readable is not "live"; the miner-alert memory is tied to one pool and one address; a pool that did not report its fee gets no cost figure (the guide's range is never used as a number), and "Real cost" is now "Cost after luck", described as the past, pool-wide figure it is. A release stops on any KESHI_* build option and checks the built files point LI.FI at Keshi's relay with no key inside. Errors are announced to screen readers, storage failures at start-up and in settings are said with a way to retry, and the dark "erase" button meets 4.5:1.
- Numbers you can trust, after the standalone audit of 6 November: the home total now counts every asset that has a price (ETH and WETH through the PRL price) and says how many unpriced assets are left out; the Mining tab says when the network's index gave only the recent part of an address's history (so "All time" is not all time), what it counts as income (block rewards and payments to the payout address, less those matching your bridge returns), and how many older payouts had no price for their day; a followed miner whose payout address is another wallet's is shown as "Watched miner"; two rigs with the same name stay two; the calculator refuses a figure it cannot read instead of treating it as zero; the network card says "no answer" instead of "reading…" forever; the relay takes Keshi's fee on the purchase leg (USDT on Ethereum) as the screen says. Development dependency vite updated (advisory on its Windows editor path, never in the extension).
- Quicker to the point: the welcome screen's buttons appear in just over a second instead of three, the pearl opens in three quarters of a second after unlock instead of a second and a half, the two fonts are preloaded so text no longer shifts on open, and the Mining tab shows its last figures at once when you come back to it and refreshes behind.
- After a second review of the pool code: every figure a pool sends is capped before any unit is applied, so none can reach infinity on its way to the screen; a balance of more than 18 digits is not believed; long amounts are grouped in one pass; a worker missing from the pool's list for a week is forgotten rather than reported stopped forever; a worker that goes off while already low is not announced low again when it comes back; HeroMiners' luck is shown only while the pool really finds blocks; a LuckyPool candidate block counts as found; the Connect sheet's dot is grey, not red, when the pool did not answer.
- One Pools card, right under the network figures: six pools, each with its dot, Follow and Connect. It replaces the "Connect my pool" card and the folded list at the bottom, which showed pools in two places. Follow opens "My miner" with that pool chosen.
- Only public pool pages are read for this: no address, nothing about the user is sent.

Ethereum
- A warning on the Swap tab when the wallet's Ethereum address carries an EIP-7702 delegation. Keshi never signs one, so a delegation there was set elsewhere with the same key, and the contract it names can move whatever the address holds: Keshi says so and advises moving the funds to a new wallet. Read from the address's code on every visit, nothing is sent.

Settings
- The version shown in Settings now comes from the package itself; it read 1.0.4 before.

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

After an outside audit (October 2026)
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

Firefox
- Before anything is sent, Firefox shows a clear consent page right after install (and after updating, for anyone who has not accepted yet): what Keshi sends, to whom, and what is never sent. Until "Accept", Keshi sends nothing at all. "Decline" sends nothing and offers to remove Keshi. Firefox 140+ also shows its own built-in data consent. Chrome is unchanged.

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
