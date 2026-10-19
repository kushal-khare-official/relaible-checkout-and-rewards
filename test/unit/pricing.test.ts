import { describe, expect, it } from 'vitest';
import { percentageOf } from '../../src/domain/money.js';
import { priceOrder } from '../../src/domain/pricing.js';
import { normalizeCouponCode, generateCouponCode } from '../../src/domain/coupon-code.js';

const line = (productId: string, unitPricePaise: number, quantity: number) => ({
  productId,
  productName: productId,
  unitPricePaise,
  quantity,
});

describe('priceOrder', () => {
  it('floors the discount to whole paise so it never exceeds the advertised percent', () => {
    // 10% of 49.99 is 4.999 -> discount 4.99, customer pays 45.00
    const pricing = priceOrder([line('sticker', 4_999, 1)], 1_000);
    expect(pricing.discountPaise).toBe(499);
    expect(pricing.totalPaise).toBe(4_500);
  });

  it('applies the discount once to the subtotal, not per line', () => {
    // Per-line flooring would give 349 + 349 + 349 = 1047; order-level gives floor(1048.5) = 1048.
    const pricing = priceOrder([line('cap', 3_495, 3)], 1_000);
    expect(pricing.subtotalPaise).toBe(10_485);
    expect(pricing.discountPaise).toBe(1_048);
    expect(pricing.totalPaise).toBe(9_437);
  });

  it('sums line totals into the subtotal and leaves totals untouched without a coupon', () => {
    const pricing = priceOrder([line('tee', 49_900, 2), line('cap', 34_950, 1)], null);
    expect(pricing.lines.map((l) => l.lineTotalPaise)).toEqual([99_800, 34_950]);
    expect(pricing.subtotalPaise).toBe(134_750);
    expect(pricing.discountPaise).toBe(0);
    expect(pricing.totalPaise).toBe(134_750);
  });

  it('never produces a negative total, even at 100% off', () => {
    const pricing = priceOrder([line('hoodie', 149_900, 1)], 10_000);
    expect(pricing.discountPaise).toBe(149_900);
    expect(pricing.totalPaise).toBe(0);
  });

  it('is independent of line order (deterministic)', () => {
    const a = priceOrder([line('a', 333, 3), line('b', 1_001, 7)], 1_250);
    const b = priceOrder([line('b', 1_001, 7), line('a', 333, 3)], 1_250);
    expect([a.subtotalPaise, a.discountPaise, a.totalPaise]).toEqual([
      b.subtotalPaise,
      b.discountPaise,
      b.totalPaise,
    ]);
  });
});

describe('percentageOf', () => {
  it('stays exact for large amounts where float math would drift', () => {
    // 0.07 * 1e15 in floating point is 70000000000000.01; integer math is exact.
    expect(percentageOf(1_000_000_000_000_000, 700)).toBe(70_000_000_000_000);
  });

  it('rejects out-of-range percentages and fractional paise', () => {
    expect(() => percentageOf(100, 10_001)).toThrow(RangeError);
    expect(() => percentageOf(100, -1)).toThrow(RangeError);
    expect(() => percentageOf(10.5, 100)).toThrow(RangeError);
  });
});

describe('coupon codes', () => {
  it('normalises customer input', () => {
    expect(normalizeCouponCode('  save10-abcd ')).toBe('SAVE10-ABCD');
  });

  it('generates prefixed, unambiguous codes', () => {
    const code = generateCouponCode(10);
    expect(code).toMatch(/^SAVE10-[0-9A-HJKMNP-TV-Z]{8}$/);
  });
});
