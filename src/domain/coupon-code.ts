import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O, U, so codes survive being read aloud or retyped.
// 32 symbols divide 256 evenly, so masking a random byte introduces no bias.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** e.g. SAVE10-7KQ2M9XD (40 bits of randomness; codes are bearer tokens). */
export function generateCouponCode(percent: number): string {
  const suffix = Array.from(randomBytes(8), (byte) => ALPHABET[byte & 31]).join('');
  return `SAVE${percent}-${suffix}`;
}

/** Codes are case-insensitive for customers; stored and compared upper-case. */
export function normalizeCouponCode(input: string): string {
  return input.trim().toUpperCase();
}
