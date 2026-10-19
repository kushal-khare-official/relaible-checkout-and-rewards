import { z } from 'zod';
import { PaiseSchema } from '../../http/schemas.js';
import { MAX_LINE_QUANTITY } from '../../domain/pricing.js';

export const QuantitySchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LINE_QUANTITY)
  .describe(`Whole units, 1-${MAX_LINE_QUANTITY}. Use DELETE to remove a line.`);

const CartLineSchema = z.object({
  productId: z.string(),
  name: z.string(),
  quantity: z.number().int(),
  unitPricePaise: PaiseSchema,
  acknowledgedUnitPricePaise: PaiseSchema,
  priceChanged: z.boolean(),
  lineTotalPaise: PaiseSchema,
  availableStock: z.number().int(),
  sufficientStock: z.boolean(),
});

const CartIssueSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('PRICE_CHANGED'),
    productId: z.string(),
    acknowledgedUnitPricePaise: PaiseSchema,
    currentUnitPricePaise: PaiseSchema,
  }),
  z.object({
    code: z.literal('INSUFFICIENT_INVENTORY'),
    productId: z.string(),
    requested: z.number().int(),
    available: z.number().int(),
  }),
]);

export const CartSchema = z.object({
  id: z.string(),
  status: z.enum(['OPEN', 'CHECKED_OUT']),
  orderId: z.string().nullable(),
  currency: z.string(),
  items: z.array(CartLineSchema),
  itemCount: z.number().int(),
  subtotalPaise: PaiseSchema,
  issues: z.array(CartIssueSchema),
  checkoutReady: z.boolean(),
  couponPreview: z
    .object({
      code: z.string(),
      status: z.enum(['APPLICABLE', 'NOT_FOUND', 'ALREADY_REDEEMED']),
      discountPercent: z.number().nullable(),
      discountPaise: PaiseSchema,
      estimatedTotalPaise: PaiseSchema,
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
