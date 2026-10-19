/**
 * Money is always an integer number of paise (1 INR = 100 paise). Floats never hold money;
 * percentages are integer basis points (1% = 100 bps).
 */
export type Paise = number;

export const CURRENCY = 'INR';
export const BPS_PER_WHOLE = 10_000;

export function assertPaise(value: number, label = 'amount'): Paise {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of paise, got ${value}`);
  }
  return value;
}

export function multiply(unitPaise: Paise, quantity: number): Paise {
  return assertPaise(unitPaise * quantity, 'line total');
}

/**
 * floor(amount * bps / 10000), computed in BigInt so the intermediate product cannot lose
 * precision. Flooring means a discount never exceeds the advertised percentage.
 */
export function percentageOf(amount: Paise, bps: number): Paise {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_PER_WHOLE) {
    throw new RangeError(`bps must be an integer in [0, ${BPS_PER_WHOLE}], got ${bps}`);
  }
  return Number((BigInt(assertPaise(amount)) * BigInt(bps)) / BigInt(BPS_PER_WHOLE));
}
