## Keshi 1.0.6

Pearl Fortune workers read as the pool really answers, a payment alert, payouts in USDT at PearlHash, Peryn's 18 servers, a calculator with 40 cards, Pearl's releases, new exchanges and scheduled forks in Explore, and Keshi's terms shown once with an optional, anonymous wallet count. Same keys, same addresses, same fees, same permissions.

Mining
- Pearl Fortune workers showed 0 H/s, no time of last work, and "online" even when disconnected: the pool nests those figures per session, which 1.0.5 did not read. Each worker now shows the hashrate its miner reports, the hashrate the pool measured over 1 hour and 24 hours, its graphics card and miner version, when it connected and when it last sent work. A worker whose sessions are all stale is offline. Checked against the pool's answer for a farm of 221 rigs (16 November 2026), three of which are kept as a test fixture. The stop and hashrate alerts for Pearl Fortune rely on these figures and were unreliable before.
- Payment alert, next to the worker alert in "My miner": a notification when PRL arrives on the address you follow, even with Keshi closed or locked, while Chrome is running. Keshi asks Pearl's public indexer once a minute what the address received; only the address is sent. When the address is one of the wallet's, the payment is announced once, as "PRL received on your mining address", not a second time as "PRL received". Any PRL sent to that address counts, so the notification does not claim it comes from the pool. On for a miner followed from 1.0.6; off, until ticked, for one followed before.
- PearlHash can pay in USDT (its Auto-Exchange): Connect offers "PEARL" or "USDT on Ethereum". With USDT, the username is AE- followed by the wallet's own Ethereum address, and the command is PearlHash's own. PearlHash sells the PRL and sends the USDT; Keshi holds nothing and takes no fee. The terms shown (paid in batches from the equivalent of 5 PRL, with no fixed time promised; 0% auto-exchange service fee for now, separate from the pool's mining fee; exchange and network fees deducted) are PearlHash's, as its guide stated them on 11 November 2026.
- Peryn: its 18 locations as peryn.ai lists them (ten more: Chicago, St Petersburg, Toronto, Buenos Aires, Santiago, Warsaw, Moscow, Tel Aviv, Johannesburg, Sydney), all on 3333 and TLS 3443. "US West" is Silicon Valley, as Peryn names it. Peryn Miner's 1% dev fee on other pools is noted.
- Pearl Fortune: its Japan server, for third-party miners (8888) and its own miner (443). PPS is the default and PPLNS is set by the pool's administrators, as its guide says; 1.0.5 said the mode was chosen on its site.
- Profit calculator: 40 cards instead of 13, with RTX 20, more RTX 30/40/50 models and data-centre cards. Figures are those Pearl Fortune measured with its own miner (v2.4.0, November 2026), and are said to be the best case of one miner.

Home
- The price curve ends on the live price, the one the balance above it is valued at: the two figures showed a cent apart when the last candle was a few minutes old.
- What the balance gained or lost over the chosen period has its own line, "Your PRL over this period", instead of sitting unlabelled next to the price's percentage.
- Bridge tracking: a crossing in the "attested" step, a normal one, and a return trip the bridge reports as "unlocked", its word for finished, were shown as "Held for review by the bridge". They now read "On its way" and "PRL released". Display only: no crossing was affected. Checked against the states PearlBridge lists in its developer documentation.

Terms and privacy
- "Before you use Keshi", once, before the wallet: five points in plain words (your keys are yours alone, no warranty, outside services have their own terms, fees are shown before you confirm, no advice), and one box to accept them. They can be read again in Settings.
- "Help us count Keshi wallets?", asked on a second screen as a question with two answers of the same size ("No thanks" / "Yes, count me") and none chosen in advance: Keshi works the same after a no. After a yes, Keshi sends one signal a day at most to Keshi's own counter (stats.keshiwallet.com), holding only: Keshi's version, the browser's name, whether it is the first signal of the week, of the month and ever, and three numbers (wallets held, created and restored on this device). No address, no balance, no identifier, no time; the counter keeps totals per day and does not store the IP address. Settings > Privacy turns it on or off at any time; turning it off also forgets the numbers waiting to be sent. The counter's code is in relay/stats-worker.js.
- Security review of this version (test/audit-106.test.ts): a hostile pool answer (negative or absurd figures, markup in names, thousands of sessions) is bounded before it reaches the screen or the alerts; only a well-formed Ethereum address is ever written after AE-; a signal is built from bounded numbers whatever sits in storage, and only an exact tick turns counting on; the counter refuses bodies over 1 kB before reading them.
- The Bridge explanation says that PearlBridge has its own terms and sees the addresses of a crossing.

Unchanged
- No new permission: the extension asks for exactly what 1.0.5 asked for. The new addresses it may contact are Keshi's counter (only for those who answered yes) and GitHub, for Pearl's public releases and parameters in Explore.
- Keys, addresses, recovery phrases, fees, swaps, the bridge and Buy with USDT are untouched.

Bridge
- After the check, when PearlBridge's minimum applies, the quote says what it weighs on this amount (for 100 PRL: 4 PRL, 4%). The figures come from PearlBridge's own quote. The explanation of fees under the button is the one of 1.0.6, unchanged.
- A crossing on its way shows where it stands: "4 of 6 confirmations · about 6 min left", with a bar. The confirmations are those of your payment on Pearl, read from Pearl's indexer; the number to reach is the one PearlBridge's quote asked for; the time left is an estimate at Pearl's usual pace. Once the confirmations are in, the line says that PearlBridge is issuing the wPRL, or that its safety delay is running. The bar never shows a crossing as finished: only PearlBridge's answer does. While the Bridge screen is open, a crossing on its way is read again every 30 seconds.
- Arrival alert, best effort: a notification when the wPRL is issued (or the PRL released, on the way back), even with Keshi closed or locked, while the browser is running. A refund, a failure or a hold for review is announced the same way. While a crossing is on its way, Keshi asks PearlBridge's public API about it once a minute, with its transaction number only. For that, the transaction number and the direction of the crossing (no amount, no address) are kept outside the encrypted storage until it arrives, three days at most. It is on by default; the Bridge screen says so in one line, and its switch, with this explanation, is in Settings, Privacy. Turning it off forgets them at once. Notifications carry no amount.
- Selling after a crossing, with nothing to tick: when the wPRL goes to your own Ethereum address, the quote has a line to unfold, "Planning to sell it for ETH afterwards?", with what that wPRL would fetch on Uniswap at this minute (Keshi's swap fee included), what the sale costs in Ethereum fees, and a warning if your Ethereum address does not hold that ETH yet. Nothing is sold in advance and nothing is signed for later: once the wPRL is there, the Bridge screen offers "Sell it for ETH on Uniswap", which opens the usual sale with today's price for you to check and confirm.

Swap
- A simpler Swap screen. The bridge is offered once instead of twice: put forward under the amount when you want to sell wPRL and have none (or not enough), and as a quiet button at the bottom otherwise. The choice of direction and the amount come first; the note on Ethereum fees is shorter; the details (WETH, the 20-minute limit, who sets the fees) are folded under "Good to know". The 1% price limit and "a confirmed swap cannot be reversed" stay visible. Nothing changes in how a swap is quoted, checked or sent.

Send
- Max shows the amount instead of the word "Everything": what you can send once the network fee at the chosen speed is taken out, worked out the way the payment itself will be, with the fee named underneath. The review screen shows the same figure. On the ETH and wPRL send screens, Max shows what you hold. Nothing changes in how a payment is built or sent.


**Check it yourself**

```
npm ci
npm run build
node verify.mjs
```

`All 17 files match Keshi 1.0.6.` means this code makes the files of the Store package.

`keshi-chrome-1.0.6.zip` is the package to upload to the Chrome Web Store.
SHA-256: `62fccfd39d463164affdcc030cf441ffccfd28622d26f279ee0ad6e929526176`
