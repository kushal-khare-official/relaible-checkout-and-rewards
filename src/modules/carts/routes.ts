import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ProductIdSchema, UuidSchema, problems } from '../../http/schemas.js';
import { CartSchema, QuantitySchema } from './schemas.js';
import type { CartService } from './service.js';

const CartParams = z.object({ cartId: UuidSchema });
const CartItemParams = z.object({ cartId: UuidSchema, productId: ProductIdSchema });

export const cartRoutes =
  (carts: CartService): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/carts',
      {
        schema: {
          tags: ['cart'],
          summary: 'Create an empty cart',
          response: { 201: CartSchema },
        },
      },
      async (_request, reply) => reply.status(201).send(await carts.create()),
    );

    app.get(
      '/carts/:cartId',
      {
        schema: {
          tags: ['cart'],
          summary: 'View a cart with live prices, totals and checkout readiness',
          description:
            'Side-effect free. Pass ?couponCode= to preview a discount (nothing is reserved).',
          params: CartParams,
          querystring: z.object({ couponCode: z.string().min(1).max(64).optional() }),
          response: { 200: CartSchema, ...problems(400, 404) },
        },
      },
      async (request) => carts.get(request.params.cartId, request.query.couponCode),
    );

    app.post(
      '/carts/:cartId/items',
      {
        schema: {
          tags: ['cart'],
          summary: 'Add units of a product (adds to an existing line)',
          params: CartParams,
          body: z.object({ productId: ProductIdSchema, quantity: QuantitySchema }),
          response: { 200: CartSchema, ...problems(400, 404, 409, 422) },
        },
      },
      async (request) =>
        carts.addItem(request.params.cartId, request.body.productId, request.body.quantity),
    );

    app.put(
      '/carts/:cartId/items/:productId',
      {
        schema: {
          tags: ['cart'],
          summary: 'Set the quantity of a line (creates it if absent; idempotent)',
          params: CartItemParams,
          body: z.object({ quantity: QuantitySchema }),
          response: { 200: CartSchema, ...problems(400, 404, 409, 422) },
        },
      },
      async (request) =>
        carts.setItem(request.params.cartId, request.params.productId, request.body.quantity),
    );

    app.delete(
      '/carts/:cartId/items/:productId',
      {
        schema: {
          tags: ['cart'],
          summary: 'Remove a line (idempotent)',
          params: CartItemParams,
          response: { 200: CartSchema, ...problems(400, 404, 409) },
        },
      },
      async (request) => carts.removeItem(request.params.cartId, request.params.productId),
    );

    app.post(
      '/carts/:cartId/acknowledge-prices',
      {
        schema: {
          tags: ['cart'],
          summary: 'Accept current catalogue prices for every line',
          description:
            'Call after a PRICE_CHANGED response (or when the cart view shows priceChanged). Checkout charges only acknowledged prices.',
          params: CartParams,
          response: { 200: CartSchema, ...problems(400, 404, 409) },
        },
      },
      async (request) => carts.acknowledgePrices(request.params.cartId),
    );
  };
