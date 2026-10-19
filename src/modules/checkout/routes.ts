import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Errors } from '../../domain/errors.js';
import { UuidSchema, problems } from '../../http/schemas.js';
import { OrderSchema } from '../orders/schemas.js';
import type { CheckoutService } from './service.js';

export const checkoutRoutes =
  (checkout: CheckoutService): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/carts/:cartId/checkout',
      {
        schema: {
          tags: ['checkout'],
          summary: 'Check out a cart, optionally with a coupon',
          description: [
            'Requires an `Idempotency-Key` header (1-255 chars, e.g. a UUID generated per checkout attempt).',
            'Retrying with the same key and body returns the original 201 response with `Idempotent-Replayed: true`.',
            'Reusing a key for a different cart or coupon returns 422 IDEMPOTENCY_KEY_REUSED.',
            'Failed attempts consume nothing (no stock, no coupon, no key) and may be retried with the same key.',
          ].join('\n\n'),
          params: z.object({ cartId: UuidSchema }),
          headers: z.object({ 'idempotency-key': z.string().optional() }),
          // Fastify passes null for a bodiless POST; no body means no coupon.
          body: z.object({ couponCode: z.string().min(1).max(64).optional() }).nullish(),
          response: { 201: OrderSchema, ...problems(400, 402, 404, 409, 422, 503) },
        },
      },
      async (request, reply) => {
        const idempotencyKey = request.headers['idempotency-key'];
        if (!idempotencyKey || idempotencyKey.length > 255) throw Errors.idempotencyKeyRequired();
        const result = await checkout.checkout({
          cartId: request.params.cartId,
          couponCode: request.body?.couponCode,
          idempotencyKey,
        });
        if (result.replayed) reply.header('Idempotent-Replayed', 'true');
        return reply.status(201).send(result.order);
      },
    );
  };
