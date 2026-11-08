## Keshi 1.0.5

Peryn, PearlHash, Pearl Fortune and LuckyPool in the Mining tab, followed like the other pools, a dot next to each pool that answers, Connect details and the cost after luck of each pool, a hashrate alert, and an EIP-7702 warning on Ethereum. Same keys, same addresses, same fees.

Mining
- Peryn can be followed like Kryptex and HeroMiners, from its documented API (docs.peryn.ai, app.peryn.ai/api/v1): every worker, who is online as Peryn counts it (an accepted share in the last few minutes), the balance owed, and a notification when a worker stops, even with Keshi closed or locked. Only the payout address is sent, no account. The pool line shows what Peryn reports: hashrate, miners, payouts every 2 hours from 1 PRL, and its fee (1% on PPS+, the default, and on PPLNS).
- PearlHash can be followed too, from the page its site reads for one address (pearlhash.xyz/api/account): the workers connected right now, the hashrate, the balance as the sum of its movements, and a notification when a worker leaves the list. Its line shows the pool's hashrate and accounts from pearlhash.xyz/api/stats; the fee is as PearlHash announces it (1%). "Open PearlHash" opens that address's own page on the pool.
- Pearl Fortune can be followed as well, from the pages its Address Lookup reads (pearlfortune.org/api/v1): the rolling hashrate, the workers connected, the balance from the ledger, and the fee of the address's own payment mode (2% PPLNS or 4% PPS, as the pool reports them). Its line shows the pool's hashrate and blocks found in 24 hours.
- LuckyPool can be followed as well, from the pages its "Your stats" reads (pearl.luckypool.io/api): hashrate, 24-hour average, workers, balance (unlocked and locked) and paid, with the pool's fee; its line shows its hashrate, miners and 2-hourly payouts from 1 PRL, and its last two days of blocks give the luck. Connect lists its 19 servers, the three ports by rig size, solo and Nockchain merge-mining formats.
- "My miner" also shows the 24-hour average hashrate (Peryn, HeroMiners, Pearl Fortune, LuckyPool) and what the pool has paid so far (Peryn, HeroMiners, LuckyPool, Kryptex, PearlHash), when the pool reports them. Peryn's line shows its Founding Miners rate as Peryn announces it.
- Pools guide corrected from the pools' own pages. AlphaPool is no longer listed. The pool chooser in "My miner" has six pools on two rows.
- Connect, next to Follow on every pool that can be followed: the pool's addresses by region (with the TLS port), your username with the worker name filled in, the password the pool asks for, each with a Copy button, a dot for the pool and, at Peryn, a dot per server as the pool reports it. Only what a miner needs to start is shown (the four nearest servers); More unfolds the other servers, one command line for the miner the pool documents first, and the pool's options, and a button opens the pool's own setup guide. The addresses are as each pool's site lists them, not read from the network, so the pool's guide (linked) is the reference if one moves.
- "Cost after luck" per pool: the fee the pool reported just now, plus how the pool's luck ran for everyone (blocks found against blocks its hashrate should have found) for PPLNS and PROP pools that publish their blocks (HeroMiners from its own 7-day effort, Pearl Fortune over a week, LuckyPool from its own 7-day effort, or its last two days of blocks when that page is missing). PPS and PPS+ pools pay per share, so their cost is their fee. It is a past, pool-wide figure, not a charge and not a promise of your own yield; a pool that did not report its fee gets no figure (the guide's range is never used as a number). Shown as "—" when the pool's hashrate should have found fewer than 20 blocks over the window, because the figure would be noise.
- What your hashrate would earn per day at each pool, fee taken, once you follow a miner: the same network figures as the profit calculator, pool by pool.
- A hashrate alert next to the offline alert: when a worker still mines but sits under 60% of its usual hashrate on two checks in a row (a card dropped out, a rig throttled), one notification however many workers it concerns, and another only after they are back over 80%. The usual hashrate is learned over the first readings; a worker connected less than 30 minutes ago, or one climbing back after a restart, is never a drop.
- A worker that leaves a pool's list of connected workers (PearlHash and Pearl Fortune list only those) is announced after the chosen delay, like an idle one: a reconnection that straddles a check is not a stop. Every worker of a farm, however many, is watched by the alerts; the screen lists the first thousand. A pool's answer is cut off at 4 MB before it is parsed, and every amount, name and list in it is bounded before it is read: a hostile or runaway answer is dropped, not waited for. A worker list the pool failed to send is "unknown", never an empty list, so no worker is reported stopped from a failed request.
- HeroMiners hashrates are read in the pool's unit (2^32 hashes): a followed miner showed a few kH/s instead of its real TH/s or PH/s before. Its pool fee is read for the real-yield figure, its line shows its real hashrate, miners and hourly payout, and its own 7-day effort gives the luck behind the real cost. Kryptex's line shows its hashrate, miners and minimum payout as its pool page reports them.
- Kryptex workers are read as Kryptex really answers (avg_hashrate_30m, status, last_share in milliseconds): they showed 0 H/s and offline before. A farm's thousands of workers all count in the totals. Connect for Kryptex writes the username as the pool does, wallet/worker, and lists its Russia server. HeroMiners' 15 servers as its site lists them, its PROP scheme, hourly payouts from 1 PRL, and a 0% fee read as such when the pool states it.
- Kryptex's fee is read as the pool reports it (a fraction, "0.03" for 3%): it showed as 0.03% before. The same reading feeds the real-yield figure.
- One Pools card, right under the network figures: six pools, each with its dot, Follow and Connect. It replaces the "Connect my pool" card and the folded list at the bottom, which showed pools in two places. Follow opens "My miner" with that pool chosen.
- A green dot next to each of the six pools when the pool's page answered Keshi just now; a grey one when it did not, which can be the pool, the network or this computer. Asked when the Mining tab opens and once a minute while it stays open; only public pool pages are read, nothing about the user is sent.

Ethereum
- A warning on the Swap tab when the wallet's Ethereum address carries an EIP-7702 delegation. Keshi never signs one, so a delegation there was set elsewhere with the same key, and the contract it names can move whatever the address holds: Keshi says so and advises moving the funds to a new wallet. Read from the address's code on every visit, nothing is sent.

Settings
- The version shown in Settings now comes from the package itself; it read 1.0.4 before.

**Check it yourself**

```
npm ci
npm run build
node verify.mjs
```

`All 17 files match Keshi 1.0.5.` means this code makes the files of the Store package.

`keshi-chrome-1.0.5.zip` (attached) is the package uploaded to the Chrome Web Store.
SHA-256: `7cf616294fcf20ce1a5f6b3681304484ee5ad3a88b6963ef94af243c7eab1787`
