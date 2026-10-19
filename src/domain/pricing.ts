import { assertPaise, multiply, percentageOf, type Paise } from './money.js';

export const MAX_LINE_QUANTITY = 100;

export interface LineInput {
  productId: string;
  productName: string;
  unitPricePaise: Paise;
  quantity: number;
}

export interface PricedLine extends LineInput {
  lineTotalPaise: Paise;
}

export interface OrderPricing {
  lines: PricedLine[];
  subtotalPaise: Paise;
  discountBps: number | null;
  discountPaise: Paise;
  totalPaise: Paise;
}

/**
 * The single pricing rule shared by cart view, coupon preview and checkout:
 *   line total = unit price x quantity
 *   subtotal   = sum of line totals
 *   discount   = floor(subtotal x bps / 10000), applied once to the subtotal (never per line,
 *                so there is no per-line rounding to reconcile)
 *   total      = subtotal - discount, which is >= 0 because bps <= 10000
 * Deterministic: same inputs always give the same paise, independent of line order.
 */
export function priceOrder(lines: readonly LineInput[], discountBps: number | null): OrderPricing {
  const priced = lines.map((line) => ({
    ...line,
    lineTotalPaise: multiply(line.unitPricePaise, line.quantity),
  }));
  const subtotalPaise = assertPaise(
    priced.reduce((sum, line) => sum + line.lineTotalPaise, 0),
    'subtotal',
  );
  const discountPaise = discountBps === null ? 0 : percentageOf(subtotalPaise, discountBps);
  const totalPaise = subtotalPaise - discountPaise;
  if (totalPaise < 0) {
    // Unreachable while bps <= 10000; kept as an explicit guard on the invariant.
    throw new Error('Order total cannot be negative');
  }
  return { lines: priced, subtotalPaise, discountBps, discountPaise, totalPaise };
}
