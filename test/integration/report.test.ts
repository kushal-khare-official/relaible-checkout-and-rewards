import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkout,
  countRows,
  createCart,
  createHarness,
  generateCoupon,
  json,
  placeOrders,
  resetHarness,
  type TableName,
  type TestHarness,
} from '../setup/helpers.js';

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness({ everyNOrders: 2, discountPercent: 15 });
});
afterAll(async () => h.close());
beforeEach(async () => resetHarness(h));

const getReport = async () => json(await h.app.inject({ method: 'GET', url: '/admin/report' }));

/** A history with discounted, undiscounted and failed checkouts. */
async function buildHistory() {
  await placeOrders(h.app, 4); // milestones 2 and 4
  const c1 = await generateCoupon(h.app);
  await generateCoupon(h.app); // stays available

  // Filled while stock allows; another order takes the stock before this one checks out.
  const tooMany = await createCart(h.app, { 'sneaker-ltd': 2 });
  const discounted = await createCart(h.app, { cap: 3, sticker: 2 });
  expect((await checkout(h.app, discounted, 'r-1', c1)).statusCode).toBe(201);
  const plain = await createCart(h.app, { 'sneaker-ltd': 2, mug: 1 });
  expect((await checkout(h.app, plain, 'r-2')).statusCode).toBe(201);

  // Failures must leave no trace in the numbers.
  const reused = await createCart(h.app, { tee: 1 });
  expect((await checkout(h.app, reused, 'r-3', c1)).statusCode).toBe(409);
  expect((await checkout(h.app, tooMany, 'r-4')).statusCode).toBe(409);
}

function expectInternallyConsistent(report: any) {
  expect(report.grossRevenuePaise - report.totalDiscountsPaise).toBe(report.netRevenuePaise);
  const productGross = report.products.reduce((s: number, p: any) => s + p.grossRevenuePaise, 0);
  expect(productGross).toBe(report.grossRevenuePaise);
  expect(report.coupons.available + report.coupons.redeemed).toBe(report.coupons.generated);
}

describe('admin report', () => {
  it('reconciles exactly with the orders and coupons the API returns', async () => {
    await buildHistory();

    const report = await getReport();
    const orders = json(await h.app.inject({ method: 'GET', url: '/admin/orders?limit=500' }));
    const coupons = json(await h.app.inject({ method: 'GET', url: '/admin/coupons' })).items;

    const sum = (f: (o: any) => number) => orders.items.reduce((s: number, o: any) => s + f(o), 0);
    expect(report.totalOrders).toBe(6);
    expect(report.totalOrders).toBe(orders.total);
    expect(report.grossRevenuePaise).toBe(sum((o) => o.subtotalPaise));
    expect(report.totalDiscountsPaise).toBe(sum((o) => o.discountPaise));
    expect(report.netRevenuePaise).toBe(sum((o) => o.totalPaise));
    expectInternallyConsistent(report);

    for (const p of report.products) {
      const sold = orders.items
        .flatMap((o: any) => o.items)
        .filter((i: any) => i.productId === p.productId)
        .reduce((s: number, i: any) => s + i.quantity, 0);
      expect(p.quantitySold, p.productId).toBe(sold);
    }
    expect(report.products.find((p: any) => p.productId === 'sneaker-ltd').quantitySold).toBe(2);

    expect(report.coupons).toEqual({
      generated: coupons.length,
      available: coupons.filter((c: any) => c.status === 'AVAILABLE').length,
      redeemed: coupons.filter((c: any) => c.status === 'REDEEMED').length,
    });
    expect(report.coupons).toEqual({ generated: 2, available: 1, redeemed: 1 });
    expect(report.coupons.redeemed).toBe(orders.items.filter((o: any) => o.coupon !== null).length);
    // 15% of (3 x 34950 + 2 x 4999 = 114848) = 17227.2, floored
    expect(report.totalDiscountsPaise).toBe(17_227);
    expect(report.rewards).toMatchObject({ nextMilestoneAt: 6, eligibleUnrewardedMilestones: 1 });
  });

  it('never mutates state, however often it is requested', async () => {
    await buildHistory();
    const tables: TableName[] = [
      'orders',
      'order_items',
      'coupons',
      'carts',
      'cart_items',
      'idempotency_keys',
    ];
    const before = await Promise.all(tables.map((t) => countRows(h.db, t)));
    const productsBefore = await h.db.selectFrom('products').selectAll().orderBy('id').execute();

    const reports = await Promise.all(Array.from({ length: 5 }, getReport));

    expect(new Set(reports.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(await Promise.all(tables.map((t) => countRows(h.db, t)))).toEqual(before);
    expect(await h.db.selectFrom('products').selectAll().orderBy('id').execute()).toEqual(
      productsBefore,
    );
    expect(await generateCoupon(h.app)).toBeTruthy(); // the eligible milestone was not consumed
  });

  it('stays internally consistent while checkouts commit concurrently', async () => {
    await placeOrders(h.app, 2);
    const code = await generateCoupon(h.app);
    const carts = await Promise.all(
      Array.from({ length: 8 }, () => createCart(h.app, { tee: 1, cap: 1 })),
    );

    const results = await Promise.all([
      ...carts.map((cartId, i) =>
        checkout(h.app, cartId, `c-${cartId}`, i === 0 ? code : undefined),
      ),
      ...Array.from({ length: 8 }, getReport),
    ]);

    for (const report of results.slice(carts.length) as any[]) {
      expectInternallyConsistent(report);
    }
    expectInternallyConsistent(await getReport());
  });
});
