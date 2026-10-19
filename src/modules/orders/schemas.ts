import { z } from 'zod';
import { PaiseSchema } from '../../http/schemas.js';

export const OrderSchema = z.object({
  id: z.string(),
  cartId: z.string(),
  status: z.literal('PLACED'),
  currency: z.string(),
  items: z.array(
    z.object({
      productId: z.string(),
      productName: z.string().describe('Snapshot at checkout'),
      unitPricePaise: PaiseSchema.describe('Snapshot at checkout'),
      quantity: z.number().int(),
      lineTotalPaise: PaiseSchema,
    }),
  ),
  subtotalPaise: PaiseSchema,
  coupon: z
    .object({ code: z.string(), discountBps: z.number().int(), discountPercent: z.number() })
    .nullable(),
  discountPaise: PaiseSchema.describe('floor(subtotal * discountBps / 10000)'),
  totalPaise: PaiseSchema.describe('subtotal - discount'),
  paymentReference: z.string(),
  placedAt: z.string(),
});
