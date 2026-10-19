import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config.js';
import type { Db } from './db/database.js';
import { AppError } from './domain/errors.js';
import { toProblem } from './http/problem.js';
import { CouponService } from './modules/admin/coupons.js';
import { ProductAdminService } from './modules/admin/products.js';
import { ReportService } from './modules/admin/report.js';
import { adminRoutes } from './modules/admin/routes.js';
import { cartRoutes } from './modules/carts/routes.js';
import { checkoutRoutes } from './modules/checkout/routes.js';
import { CheckoutService, type CheckoutHooks } from './modules/checkout/service.js';
import { orderRoutes } from './modules/orders/routes.js';
import { OrderService } from './modules/orders/service.js';
import { CartService } from './modules/carts/service.js';
import { productRoutes } from './modules/products/routes.js';
import { ProductService } from './modules/products/service.js';
import { FakePaymentGateway, type PaymentGateway } from './payments/gateway.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  paymentGateway?: PaymentGateway;
  checkoutHooks?: CheckoutHooks;
  logger?: boolean | { level: string };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error, request.url);
    if (problem.status >= 500 && !(error instanceof AppError)) {
      request.log.error({ err: error }, 'request failed');
    }
    if (problem.status === 503) reply.header('Retry-After', '1');
    return reply.status(problem.status).type('application/problem+json').send(problem);
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .type('application/problem+json')
      .send({
        type: '/problems/route-not-found',
        title: 'Route not found',
        status: 404,
        detail: `No route for ${request.method} ${request.url}`,
        code: 'ROUTE_NOT_FOUND',
      }),
  );

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Reliable Checkout and Rewards API',
        version: '1.0.0',
        description:
          'Money is integer paise (INR). Errors are application/problem+json with a stable `code`. Routes under /admin are administrative.',
      },
      tags: [
        { name: 'catalogue' },
        { name: 'cart' },
        { name: 'checkout' },
        { name: 'orders' },
        { name: 'admin', description: 'Administrative operations (no auth in this exercise)' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  await app.register(productRoutes(new ProductService(deps.db)));
  await app.register(cartRoutes(new CartService(deps.db)));
  const payments = deps.paymentGateway ?? new FakePaymentGateway();
  await app.register(checkoutRoutes(new CheckoutService(deps.db, payments, deps.checkoutHooks)));
  const orders = new OrderService(deps.db);
  await app.register(orderRoutes(orders));
  await app.register(
    adminRoutes({
      coupons: new CouponService(deps.db, deps.config.rewards),
      report: new ReportService(deps.db, deps.config.rewards),
      orders,
      products: new ProductAdminService(deps.db),
    }),
  );

  return app;
}
