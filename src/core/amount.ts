// 1 PRL = 100,000,000 grains. All maths is done in grains (bigint).
export const GRAINS = 100_000_000n;

/** "1,000" could mean one thousand or one: refuse it rather than guess. */
export const ambiguous = (text: string): boolean => /^[1-9]\d{0,2}(,\d{3})+$/.test(text.trim());

export function parsePrl(text: string): bigint | null {
  if (ambiguous(text)) return null;
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d{0,8}$/.test(t) || t === "" || t === ".") return null;
  const [whole = "0", frac = ""] = t.split(".");
  return BigInt(whole || "0") * GRAINS + BigInt((frac + "00000000").slice(0, 8));
}

/** "1234567" → "1,234,567", in one pass whatever the length (a regex lookahead would be quadratic). */
export function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

export function formatPrl(grains: bigint, maxDecimals = 8): string {
  const neg = grains < 0n;
  const abs = neg ? -grains : grains;
  const whole = groupThousands((abs / GRAINS).toString());
  let frac = (abs % GRAINS).toString().padStart(8, "0").slice(0, maxDecimals).replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function prlToNumber(grains: bigint): number {
  return Number(grains) / 1e8;
}
