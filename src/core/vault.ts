import { scryptAsync } from "@noble/hashes/scrypt.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// The recovery phrase (and exchange API keys) encrypted with the user's
// password. scrypt stretches the password; XChaCha20-Poly1305 encrypts and
// detects tampering. Pure JS so the same code runs in a mobile app later.

export interface VaultFile {
  v: 1;
  salt: string;
  nonce: string;
  data: string;
  n: number;
}

export interface WalletEntry {
  name: string;
  phrase?: string;
  /** Private key as hex, for a wallet imported from a single key. */
  key?: string;
  /** How addresses come out of the phrase (see keys.ts). Absent in wallets made before 0.27: they used "standard". */
  derivation?: "pearl" | "standard";
}

export interface Secrets {
  /** Recovery phrase of the wallet in use ("" when it is a private-key wallet). */
  phrase: string;
  /** Private key (hex) of the wallet in use, when it was imported from a key. */
  key?: string;
  /** Derivation of the wallet in use. */
  derivation?: "pearl" | "standard";
  /** Every wallet kept in this vault. Absent in vaults made before several wallets were supported. */
  wallets?: WalletEntry[];
  /** Key (hex) that encrypts the rest of the wallet's local data. */
  dataKey?: string;
  exchange?: { key: string; secret: string };
  bigone?: { key: string; secret: string };
  /** Authenticator secret; when set, a 6-digit code is asked at unlock. */
  totp?: string;
}

/** Work factor of the password stretching. 2^17 is the current OWASP recommendation for scrypt. */
export const VAULT_N = 2 ** 17;
const N = VAULT_N;

async function keyFor(password: string, salt: Uint8Array, n: number) {
  return scryptAsync(new TextEncoder().encode(password.normalize("NFKC")), salt, { N: n, r: 8, p: 1, dkLen: 32 });
}

export async function lockVault(secrets: Secrets, password: string, n = N): Promise<VaultFile> {
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = await keyFor(password, salt, n);
  const data = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify(secrets)));
  return { v: 1, salt: bytesToHex(salt), nonce: bytesToHex(nonce), data: bytesToHex(data), n };
}

export async function openVault(file: VaultFile, password: string): Promise<Secrets> {
  // A tampered vault file must not be able to ask for gigabytes of memory.
  if (!Number.isInteger(file.n) || file.n < 2 || file.n > 2 ** 20) throw new Error("This wallet file is damaged.");
  const key = await keyFor(password, hexToBytes(file.salt), file.n);
  try {
    const plain = xchacha20poly1305(key, hexToBytes(file.nonce)).decrypt(hexToBytes(file.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error("Wrong password");
  }
}
