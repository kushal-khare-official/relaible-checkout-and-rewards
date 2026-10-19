import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ProductIdSchema, problems } from '../../http/schemas.js';
import { ProductSchema } from './schemas.js';
import type { ProductService } from './service.js';

export const productRoutes =
  (products: ProductService): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/products',
      {
        schema: {
          tags: ['catalogue'],
          summary: 'List products with current price and stock',
          response: { 200: z.object({ items: z.array(ProductSchema) }) },
        },
      },
      async () => ({ items: await products.list() }),
    );

    app.get(
      '/products/:productId',
      {
        schema: {
          tags: ['catalogue'],
          summary: 'Get one product',
          params: z.object({ productId: ProductIdSchema }),
          response: { 200: ProductSchema, ...problems(400, 404) },
        },
      },
      async (request) => products.get(request.params.productId),
    );
  };
