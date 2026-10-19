import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { UuidSchema, problems } from '../../http/schemas.js';
import { OrderSchema } from './schemas.js';
import type { OrderService } from './service.js';

export const orderRoutes =
  (orders: OrderService): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/orders/:orderId',
      {
        schema: {
          tags: ['orders'],
          summary: 'Get an order with its line and pricing snapshot',
          params: z.object({ orderId: UuidSchema }),
          response: { 200: OrderSchema, ...problems(400, 404) },
        },
      },
      async (request) => orders.get(request.params.orderId),
    );
  };
