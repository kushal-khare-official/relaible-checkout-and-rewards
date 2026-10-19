import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db/database.js';
import { seedProducts } from '../../src/db/seed.js';
import type { CheckoutHooks } from '../../src/modules/checkout/service.js';
import { FakePaymentGateway, type ChargeRequest } from '../../src/payments/gateway.js';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface TestHarness {
  app: FastifyInstance;
  db: Db;
  /** Set to a reason string to make the next charges decline. */
  payments: { declineReason: string | null; charges: ChargeRequest[] };
  /** Mutable so a test can widen race windows only where it needs to. */
  hooks: CheckoutHooks;
  close(): Promise<void>;
}

export async function createHarness(
  rewards: { everyNOrders: number; discountPercent: number } = {
    everyNOrders: 3,
    discountPercent: 10,
  },
): Promise<TestHarness> {
  const connectionString = inject('databaseUrl');
  const config: AppConfig = {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: connectionString,
    dbPoolMax: 40,
    rewards: { everyNOrders: rewards.everyNOrders, discountBps: rewards.discountPercent * 100 },
    seedOnStart: false,
    logLevel: 'silent',
  };
  const db = createDb({ connectionString, max: config.dbPoolMax });
  const payments: TestHarness['payments'] = { declineReason: null, charges: [] };
  const gateway = new FakePaymentGateway({
    decline: (request) => {
      payments.charges.push(request);
      return payments.declineReason;
    },
  });
  const hooks: CheckoutHooks = {};
  const app = await buildApp({
    config,
    db,
    paymentGateway: gateway,
    checkoutHooks: {
      afterProductsLocked: async () => hooks.afterProductsLocked?.(),
    },
  });
  await app.ready();
  return {
    app,
    db,
    payments,
    hooks,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function resetDatabase(db: Db): Promise<void> {
  await sql`TRUNCATE idempotency_keys, order_items, coupons, orders, cart_items, carts, products CASCADE`.execute(
    db,
  );
  await seedProducts(db);
}

export function json<T = any>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

export async function createCart(
  app: FastifyInstance,
  lines: Record<string, number>,
): Promise<string> {
  const cart = json(await app.inject({ method: 'POST', url: '/carts' }));
  for (const [productId, quantity] of Object.entries(lines)) {
    const res = await app.inject({
      method: 'PUT',
      url: `/carts/${cart.id}/items/${productId}`,
      payload: { quantity },
    });
    if (res.statusCode !== 200) throw new Error(`setup failed: ${res.body}`);
  }
  return cart.id;
}

export function checkout(
  app: FastifyInstance,
  cartId: string,
  idempotencyKey: string,
  couponCode?: string,
) {
  return app.inject({
    method: 'POST',
    url: `/carts/${cartId}/checkout`,
    headers: { 'idempotency-key': idempotencyKey },
    ...(couponCode === undefined ? {} : { payload: { couponCode } }),
  });
}

/** Places `count` one-sticker orders sequentially (used to reach reward milestones). */
export async function placeOrders(app: FastifyInstance, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const cartId = await createCart(app, { sticker: 1 });
    const res = await checkout(app, cartId, `place-${cartId}`);
    if (res.statusCode !== 201) throw new Error(`placeOrders failed: ${res.body}`);
    ids.push(json(res).id);
  }
  return ids;
}

export async function stockOf(db: Db, productId: string): Promise<number> {
  const row = await db
    .selectFrom('products')
    .select('stock')
    .where('id', '=', productId)
    .executeTakeFirstOrThrow();
  return row.stock;
}

export async function countRows(
  db: Db,
  table: 'orders' | 'coupons' | 'idempotency_keys' | 'order_items' | 'carts',
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return row.n;
}

export function statusCounts(responses: LightMyRequestResponse[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const r of responses) counts[r.statusCode] = (counts[r.statusCode] ?? 0) + 1;
  return counts;
}
