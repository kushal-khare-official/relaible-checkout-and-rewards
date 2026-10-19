import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PaiseSchema, ProductIdSchema, problems } from '../../http/schemas.js';
import { OrderSchema } from '../orders/schemas.js';
import type { OrderService } from '../orders/service.js';
import { ProductSchema } from '../products/schemas.js';
import type { CouponService } from './coupons.js';
import type { ProductAdminService } from './products.js';
import type { ReportService } from './report.js';

const CouponSchema = z.object({
  code: z.string(),
  status: z.enum(['AVAILABLE', 'REDEEMED']),
  discountBps: z.number().int(),
  discountPercent: z.number(),
  milestoneIndex: z.number().int(),
  milestoneOrderCount: z.number().int(),
  redeemedOrderId: z.string().nullable(),
  createdAt: z.string(),
  redeemedAt: z.string().nullable(),
});

const ReportSchema = z.object({
  currency: z.string(),
  totalOrders: z.number().int(),
  grossRevenuePaise: PaiseSchema.describe('Sum of order subtotals, before discounts'),
  totalDiscountsPaise: PaiseSchema.describe('Sum of discounts applied to placed orders'),
  netRevenuePaise: PaiseSchema.describe('gross - discounts = sum of order totals'),
  products: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      quantitySold: z.number().int(),
      grossRevenuePaise: PaiseSchema,
    }),
  ),
  coupons: z.object({
    generated: z.number().int(),
    available: z.number().int(),
    redeemed: z.number().int(),
  }),
  rewards: z.object({
    everyNOrders: z.number().int(),
    discountPercent: z.number(),
    rewardedMilestones: z.number().int(),
    nextMilestoneAt: z.number().int(),
    eligibleUnrewardedMilestones: z.number().int(),
  }),
});

export interface AdminServices {
  coupons: CouponService;
  report: ReportService;
  orders: OrderService;
  products: ProductAdminService;
}

/** Everything under /admin is administrative. No auth here by design of the exercise. */
export const adminRoutes =
  (services: AdminServices): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/admin/coupons',
      {
        schema: {
          tags: ['admin'],
          summary: 'Generate the coupon for the oldest unrewarded order milestone',
          description:
            'Creates at most one coupon per call. 409 NO_ELIGIBLE_MILESTONE (with nextMilestoneAt) when every reached milestone already has a coupon.',
          response: { 201: CouponSchema, ...problems(409) },
        },
      },
      async (_request, reply) => reply.status(201).send(await services.coupons.generate()),
    );

    app.get(
      '/admin/coupons',
      {
        schema: {
          tags: ['admin'],
          summary: 'List coupons',
          querystring: z.object({ status: z.enum(['AVAILABLE', 'REDEEMED']).optional() }),
          response: { 200: z.object({ items: z.array(CouponSchema) }), ...problems(400) },
        },
      },
      async (request) => ({ items: await services.coupons.list(request.query.status) }),
    );

    app.get(
      '/admin/orders',
      {
        schema: {
          tags: ['admin'],
          summary: 'List placed orders (oldest first)',
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(500).default(100),
            offset: z.coerce.number().int().min(0).default(0),
          }),
          response: {
            200: z.object({
              items: z.array(OrderSchema),
              total: z.number().int(),
              limit: z.number().int(),
              offset: z.number().int(),
            }),
            ...problems(400),
          },
        },
      },
      async (request) => {
        const { limit, offset } = request.query;
        return { ...(await services.orders.list(limit, offset)), limit, offset };
      },
    );

    app.get(
      '/admin/report',
      {
        schema: {
          tags: ['admin'],
          summary: 'Sales and rewards summary (read-only, single consistent snapshot)',
          response: { 200: ReportSchema },
        },
      },
      async () => services.report.report(),
    );

    app.patch(
      '/admin/products/:productId',
      {
        schema: {
          tags: ['admin'],
          summary: 'Change a price and/or adjust stock by a signed delta',
          params: z.object({ productId: ProductIdSchema }),
          body: z
            .object({
              pricePaise: z.number().int().min(1).max(1_000_000_000).optional(),
              stockAdjustment: z.number().int().min(-1_000_000).max(1_000_000).optional(),
            })
            .refine((b) => b.pricePaise !== undefined || b.stockAdjustment !== undefined, {
              message: 'Provide pricePaise and/or stockAdjustment',
            }),
          response: { 200: ProductSchema, ...problems(400, 404, 409) },
        },
      },
      async (request) => services.products.adjust(request.params.productId, request.body),
    );
  };
