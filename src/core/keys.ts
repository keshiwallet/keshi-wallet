import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { p2tr, Address, OutScript } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { base58check, bech32m } from "@scure/base";
import { btcNet, type Network } from "./network";

// BIP-39 phrase -> BIP-86 taproot addresses (m/86'/coin'/0'/change/index).
//
// The official Pearl wallet (a fork of btcwallet) derives the three hardened
// levels with btcd's historical "non-standard" method: a private key that
// happens to start with a zero byte is kept one byte shorter, which changes
// the keys below it. For about 1 phrase in 130 the result differs from
// standard BIP-32. "pearl" reproduces the official wallet exactly; "standard"
// is plain BIP-32, as most other wallets do it.

export type Derivation = "pearl" | "standard";

const N = secp256k1.Point.Fn.ORDER;
const HARDENED = 0x80000000;

/** One hardened step the way btcd's DeriveNonStandard does it. `key` has no leading zero bytes (except the master key). */
function pearlHardened(key: Uint8Array, chainCode: Uint8Array, index: number): { key: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array(37);
  data.set(key, 1); // a 31-byte key lands one byte too far left: that is the quirk
  new DataView(data.buffer).setUint32(33, (index + HARDENED) >>> 0, false);
  const out = hmac(sha512, chainCode, data);
  const il = BigInt("0x" + bytesToHex(out.slice(0, 32)));
  if (il === 0n || il >= N) throw new Error("This recovery phrase cannot be used. Create another one.");
  const child = (il + BigInt("0x" + (bytesToHex(key) || "0"))) % N;
  if (child === 0n) throw new Error("This recovery phrase cannot be used. Create another one.");
  let hex = child.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return { key: hexToBytes(hex), chainCode: out.slice(32) };
}

/** The account key m/purpose'/coin'/account' of a seed. */
export function accountNode(seed: Uint8Array, purpose: number, coinType: number, account: number, mode: Derivation): HDKey {
  if (mode === "standard") return HDKey.fromMasterSeed(seed).derive(`m/${purpose}'/${coinType}'/${account}'`);
  const master = hmac(sha512, new TextEncoder().encode("Bitcoin seed"), seed);
  let node: { key: Uint8Array; chainCode: Uint8Array } = { key: master.slice(0, 32), chainCode: master.slice(32) };
  const m = BigInt("0x" + bytesToHex(node.key));
  if (m === 0n || m >= N) throw new Error("This recovery phrase cannot be used. Create another one.");
  for (const index of [purpose, coinType, account]) node = pearlHardened(node.key, node.chainCode, index);
  const privateKey = new Uint8Array(32);
  privateKey.set(node.key, 32 - node.key.length);
  return new HDKey({ privateKey, chainCode: node.chainCode });
}

const COIN_TYPES = [808276, 1];
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Networks (by coin type) on which the official wallet and standard BIP-32 give this phrase different addresses. */
export function derivationDiffers(phrase: string): number[] {
  const seed = mnemonicToSeedSync(cleanPhrase(phrase), "");
  return COIN_TYPES.filter((c) => [86, 222].some((p) => !same(accountNode(seed, p, c, 0, "pearl").privateKey!, accountNode(seed, p, c, 0, "standard").privateKey!)));
}

/** A new recovery phrase. Never one of the rare phrases that wallets derive differently. */
export const newPhrase = (words: 12 | 24 = 24): string => {
  for (;;) {
    const phrase = generateMnemonic(wordlist, words === 12 ? 128 : 256);
    try {
      if (derivationDiffers(phrase).length === 0) return phrase;
    } catch {
      /* unusable seed (astronomically rare): draw again */
    }
  }
};

export const cleanPhrase = (p: string): string => p.trim().toLowerCase().split(/\s+/).join(" ");

export const isValidPhrase = (p: string): boolean => validateMnemonic(cleanPhrase(p), wordlist);

export interface Derived {
  address: string;
  change: boolean;
  index: number;
  pubkey: Uint8Array; // x-only, 32 bytes
}

export interface Account {
  /** True for a wallet imported from one private key: it has a single address. */
  single?: boolean;
  derive(change: boolean, index: number): Derived;
  privateKey(change: boolean, index: number): Uint8Array;
}

export function accountFromPhrase(phrase: string, net: Network, account = 0, mode: Derivation = "pearl"): Account {
  const clean = cleanPhrase(phrase);
  if (!validateMnemonic(clean, wordlist)) throw new Error("Invalid recovery phrase");
  if (!Number.isInteger(account) || account < 0 || account >= HARDENED) throw new Error("Invalid account number");
  const seed = mnemonicToSeedSync(clean, "");
  const acct = accountNode(seed, 86, net.coinType, account, mode);
  const node = (change: boolean, index: number) => acct.deriveChild(change ? 1 : 0).deriveChild(index);
  return {
    derive(change, index) {
      const pub = node(change, index).publicKey!.slice(1);
      const address = p2tr(pub, undefined, btcNet(net)).address!;
      return { address, change, index, pubkey: pub };
    },
    privateKey(change, index) {
      return node(change, index).privateKey!;
    },
  };
}

/** Read a private key typed or pasted by the user: 64 hex characters, or the WIF format wallets export. */
export function parsePrivateKey(text: string): Uint8Array {
  const t = text.trim();
  let key: Uint8Array | undefined;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) key = hexToBytes(t.replace(/^0x/, ""));
  else {
    try {
      const raw = base58check(sha256).decode(t); // version byte, 32-byte key, optional "compressed" marker
      if (raw[0] === 0x80 && (raw.length === 33 || (raw.length === 34 && raw[33] === 1))) key = raw.slice(1, 33);
    } catch {
      /* not WIF */
    }
  }
  if (!key) throw new Error("That is not a private key. Paste 64 hex characters or a WIF key.");
  try {
    secp256k1.getPublicKey(key);
  } catch {
    throw new Error("That private key is not valid");
  }
  return key;
}

/** A wallet made of one private key. Every "address" it derives is the same one. */
export function accountFromKey(key: Uint8Array, net: Network): Account {
  const pub = secp256k1.getPublicKey(key, true).slice(1);
  const address = p2tr(pub, undefined, btcNet(net)).address!;
  return {
    single: true,
    derive: (change, index) => ({ address, change, index, pubkey: pub }),
    privateKey: () => key,
  };
}

// Pearl accepts exactly two kinds of address, both bech32m with a 32-byte program:
//   v1 "prl1p…"  Taproot (P2TR), what every wallet makes
//   v2 "prl1z…"  P2MR (BIP 360), spendable by script path only, valid since the first block
// Anything else (v0, other lengths, v3+) is refused by the Pearl node itself.
function decodeProgram(address: string, net: Network): { version: number; program: Uint8Array } | undefined {
  try {
    const { prefix, words } = bech32m.decode(address.toLowerCase() as `${string}1${string}`, 90);
    if (prefix !== net.hrp || words.length < 1) return undefined;
    const version = words[0]!;
    const program = bech32m.fromWords(words.slice(1));
    if ((version !== 1 && version !== 2) || program.length !== 32) return undefined;
    return { version, program };
  } catch {
    return undefined;
  }
}

/** True when `address` is a well-formed address for this network. */
export function isValidAddress(address: string, net: Network): boolean {
  return !!decodeProgram(address, net);
}

export function addressScript(address: string, net: Network): Uint8Array {
  const d = decodeProgram(address, net);
  if (!d) throw new Error(`That is not a valid ${net.hrp}1… address`);
  if (d.version === 1) return OutScript.encode(Address(btcNet(net)).decode(address));
  return concatBytes(Uint8Array.of(0x52, 0x20), d.program); // OP_2 <32 bytes>
}
