import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { randomBytes } from "@noble/hashes/utils.js";

// Time-based one-time codes (RFC 6238), the kind authenticator apps show.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Uint8Array {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export const newTotpSecret = (): string => base32(randomBytes(20));

export function totpCode(secret: string, timeMs = Date.now()): string {
  const counter = Math.floor(timeMs / 1000 / 30);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const h = hmac(sha1, unbase32(secret), msg);
  const o = h[19]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return (n % 1_000_000).toString().padStart(6, "0");
}

/** Accepts the current code and the ones just before and after (clock drift). */
export function verifyTotp(secret: string, code: string, timeMs = Date.now()): boolean {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  // Compared without short-circuiting, so timing says nothing about how many digits matched.
  let ok = 0;
  for (const w of [-1, 0, 1]) {
    const expect = totpCode(secret, timeMs + w * 30_000);
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= expect.charCodeAt(i) ^ c.charCodeAt(i);
    ok |= diff === 0 ? 1 : 0;
  }
  return ok === 1;
}

export const totpUri = (secret: string, label = "Keshi wallet"): string =>
  `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=Keshi&algorithm=SHA1&digits=6&period=30`;
