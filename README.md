# Keshi Wallet

**Pure Pearl. Your keys.**

Keshi is a self-custody wallet for Pearl ($PRL), free on Chrome. No account, no sign-up: your recovery phrase is created on your device and never leaves it.

- Website: https://keshiwallet.com
- Chrome Web Store: https://chromewebstore.google.com/detail/mmjkdbdkgikbhbgcmpaaahhjhmdknpnb
- X: https://x.com/Keshiwallet
- Community: https://t.me/KeshiWalletAppChat
- Contact: contact@keshiwallet.com

**To be clear**

- Keshi is independent. It is not made by Pearl Research Labs, and it is not related to keshi.io, an unrelated project with a similar name.
- Nobody, not even us, can recover your recovery phrase. Nobody from Keshi will ever ask you for it.

This repository holds the code of the Keshi browser extension, so you can read it and check it. Version in this repository: **1.0.2**, the version in the Chrome Web Store.

## What it does

Send, receive, buy, swap, bridge, mint, and track your mining. One wallet, your keys.

- Send and receive PRL, speed up a pending payment, saved addresses
- Buy and sell PRL: BigONE, SafeTrade and Uniswap prices side by side for your amount, walking each order book (you trade on the exchange's own site)
- Swap wPRL and ETH on Uniswap
- Bridge PRL to Ethereum and back with PearlBridge
- PRL-20 tokens and inscriptions: browse, mint, hold and send
- Mining rewards tracking, and combining of small payouts
- Pearl and Ethereum news
- Several wallets, and several accounts on one recovery phrase; rename or remove them
- Encrypted vault, auto-lock, optional authenticator code, look-alike address warnings, testnet mode
- A website cannot connect, sign or get paid without your click; a site you connected can read the address you gave it
- No analytics, no ads, no tracking

## What Keshi costs

| | Keshi fee |
|---|---|
| Send and receive PRL | free |
| Swap wPRL / ETH | 0.3% |
| Bridge PRL to Ethereum | 0.1% (max 3 PRL), free on the way back |
| Combine small payouts | 0.1% (max 2 PRL) |
| Mint a PRL-20 token | 0.05 PRL |

Network fees and PearlBridge's own fee are separate. Every fee is shown in the app before you confirm.
The addresses that receive Keshi's fees are in [`fees.config.json`](fees.config.json), and in the built extension.

## Is this the code in the Chrome Web Store?

You do not have to take our word for it. Rebuild the extension from this code and compare it with the published package.

1. Get the code: on this page click **Code → Download ZIP** and unzip it (or clone the repository).
2. Install [Node.js](https://nodejs.org) 22 or newer (built and tested with 22.22).
3. In the folder, run:

```
npm ci
npm run build
node verify.mjs
```

You should see `All 17 files match Keshi 1.0.2.` The list of expected files and their SHA-256 hashes is in [`verify/chrome-1.0.2.sha256`](verify/chrome-1.0.2.sha256). It was made from the package uploaded to the Chrome Web Store, so a match means this code produces the same files as the Store package.

The package that was uploaded, `keshi-chrome-1.0.2.zip`, is attached to the release of this repository. Its SHA-256 is
`61d7b9502396fc48d823b34e6d8e9226ac62f32bc810d388734441f3cdb2c3d1`.
A zip file records file dates, so a zip you rebuild yourself will have another hash; what matters is the files inside, and `verify.mjs` compares those.

Every push to this repository is also rebuilt and checked by GitHub itself: see the **Rebuild and verify** action in the Actions tab ([`.github/workflows/verify.yml`](.github/workflows/verify.yml)).

**To check the copy Chrome installed on your computer**, find its folder and give it to the script:

```
node verify.mjs "<folder>"
```

The extension ID is `mmjkdbdkgikbhbgcmpaaahhjhmdknpnb`. In Chrome the folder is usually:

- Windows: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\mmjkdbdkgikbhbgcmpaaahhjhmdknpnb\1.0.2_0`
- macOS: `~/Library/Application Support/Google/Chrome/Default/Extensions/mmjkdbdkgikbhbgcmpaaahhjhmdknpnb/1.0.2_0`
- Linux: `~/.config/google-chrome/Default/Extensions/mmjkdbdkgikbhbgcmpaaahhjhmdknpnb/1.0.2_0`

(If you use another Chrome profile or another Chromium browser, the path starts differently.) Chrome adds a `_metadata` folder, which the script ignores, and may add one `update_url` line to `manifest.json`, which the script accepts and says so.

A match shows that the Store package is made from this code. It does not show that the code has no bugs: Keshi has not been audited yet.

## What Keshi connects to

Keshi has no server of its own. The extension talks directly to these public services, and its content security policy allows connections to these only (see `host_permissions` and `content_security_policy` in [`static/manifest.base.json`](static/manifest.base.json)):

| Service | What for |
|---|---|
| blockbook.pearlresearch.ai (and the testnet one) | Pearl balances, history, broadcasting payments |
| safe.trade, big.one | Prices and order books (Keshi places no orders there) |
| api.coingecko.com | Prices and market data |
| www.pearlscriptions.com | The PRL-20 token index |
| api.pearlbridge.xyz | Bridge PRL to Ethereum and back |
| ethereum-rpc.publicnode.com, eth.drpc.org, eth.blockscout.com | Ethereum balances, history, swaps and sends |
| www.bing.com, coindesk.com, cointelegraph.com, theblock.co, decrypt.co, cryptoslate.com, beincrypto.com | The news tab |

Browser permissions: `storage` (your encrypted vault and settings stay on your device), `alarms` (the auto-lock timer and the incoming-payment check), `notifications` ("PRL received").
A small script runs on web pages so that Pearl sites can ask Keshi to connect or sign. It holds no keys. Connecting, signing and paying each open Keshi and wait for your click; a site you have connected can read back the address you gave it, until you disconnect it in Settings.

## Limits worth knowing

- Keshi looks for your addresses the way most wallets do: it stops after 20 unused receiving addresses in a row, and after 10 unused change addresses. A wallet that skipped more addresses than that would look incomplete; this does not happen with the official Pearl wallet or Keshi, which hand out addresses in order.
- A recovery phrase can hold several accounts (Settings → Wallets → Add an account), numbered like the official Pearl wallet. When a phrase is restored, Keshi also looks for the accounts it has already used, in order, and stops at the first unused one (20 at most).
- History is read 1,000 transactions at a time, up to 5,000 per address. A mining address with more payouts than that shows its balance in full, but Activity only lists the latest 5,000.
- Balances, history and broadcasts go through the public Pearl indexer (blockbook.pearlresearch.ai). Keshi checks what it can (amounts, fees, transaction IDs), but an indexer that is down or wrong can hide coins or activity until it is back. It cannot spend them.
- When the token index (pearlscriptions.com) cannot be reached, Keshi keeps the coins it already knew carry tokens aside and leaves very small coins alone, but it cannot check coins received since. It says so and asks before sending.
- When an Ethereum server or the token index does not answer, Keshi says that a figure could not be read. It never shows a zero for something it could not read.

## For developers of Pearl sites

```js
const { address } = await window.keshi.connect();
const { signature } = await window.keshi.signMessage("Sign in"); // BIP-322
const { txid } = await window.keshi.sendPayment("prl1p…", "12.5");
```

The user always sees the request and decides. Other calls: `disconnect`, `getAccounts`, `getNetwork`.

## Build, test, layout

```
npm ci
npm run build    # dist/chrome and dist/firefox
npm test         # unit tests
npm run check    # type check
```

- `src/core`: the engine: keys, addresses, encrypted vault, payments, mining, signing, swaps. It does not depend on the browser.
- `src/ui`: the screens.
- `src/ext`: what belongs to the extension: storage, website connection, background task.
- `test`: unit tests, including key-derivation vectors checked against the Go code that the Pearl Research Labs wallet runs.
- `release.mjs`: builds the store packages and refuses anything that is not a clean production build (test settings, test fee address, localhost access, source maps).

To try it without risk, switch to the testnet in Settings.

## Reporting a problem

- Security: see [SECURITY.md](SECURITY.md). Write to contact@keshiwallet.com.
- Bugs and ideas: open an issue. Say what you did, what you expected and what happened. Hide your addresses and phrases in screenshots.

## Licence

The code is published so that anyone can read and verify it. It is not open source: see [LICENSE](LICENSE). Third-party libraries keep their own licences.
