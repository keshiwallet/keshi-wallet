## Keshi 1.0.4

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

After an outside audit
- Speed up is refused for a payment sent by an older Keshi without the record of its coins.
- Buy with USDT: a quote is signed only if the chain, amount and address on screen are still the ones it was asked for; the permission address, the sender and the fees in LI.FI's answer are checked; the purchase is listed before it is sent; an unknown "finished" state is never shown as "arrived".
- The Ethereum gas limit never exceeds the wallet's ceiling.
- The store package is built only after the type check and every test pass.
- The password strength meter and the wallet list look exactly as in 1.0.3 again. "Get a quote" retries reading Ethereum. Pool lists with a bad entry and workers with no time of last work are handled. A waiting private swap is remembered across reopenings. Removing a wallet stops following its miner.
- Quantum-ready addresses are no longer created: Pearl removed that design from its own wallet (pearld 1.5.5) ahead of a new post-quantum address type. One made earlier keeps working, and Settings > Advanced finds it again after a restore.

Firefox
- Before anything is sent, Firefox shows a clear consent page right after install (and after updating, for anyone who has not accepted yet): what Keshi sends, to whom, and what is never sent. Until "Accept", Keshi sends nothing at all. "Decline" sends nothing and offers to remove Keshi. Firefox 140+ also shows its own built-in data consent. Chrome is unchanged.

**Check it yourself**

```
npm ci
npm run build
node verify.mjs
```

`All 17 files match Keshi 1.0.4.` means this code makes the files of the Store package.

`keshi-chrome-1.0.4.zip` (attached) is the package uploaded to the Chrome Web Store.
SHA-256: `da720a4ee6c57722416767b3d35c14b55bafb815e97bb5c8216a8092d9157700`
