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
  sleep,
  statusCounts,
  stockOf,
  type TestHarness,
} from '../setup/helpers.js';

// Harness rewards: every 3rd placed order unlocks a 10% coupon.
let h: TestHarness;

beforeAll(async () => {
  h = await createHarness({ everyNOrders: 3, discountPercent: 10 });
});
afterAll(async () => h.close());
beforeEach(async () => resetHarness(h));

const generate = () => h.app.inject({ method: 'POST', url: '/admin/coupons' });

async function couponRow(code: string) {
  return h.db.selectFrom('coupons').selectAll().where('code', '=', code).executeTakeFirstOrThrow();
}

describe('coupon generation', () => {
  it('only unlocks a coupon once the milestone is reached, and only once per milestone', async () => {
    let res = await generate();
    expect(res.statusCode).toBe(409);
    expect(json(res)).toMatchObject({
      code: 'NO_ELIGIBLE_MILESTONE',
      placedOrders: 0,
      nextMilestoneAt: 3,
      ordersRemaining: 3,
    });

    await placeOrders(h.app, 2);
    expect(json(await generate())).toMatchObject({ placedOrders: 2, ordersRemaining: 1 });

    await placeOrders(h.app, 1);
    res = await generate();
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({
      status: 'AVAILABLE',
      discountPercent: 10,
      milestoneIndex: 1,
      milestoneOrderCount: 3,
    });

    res = await generate();
    expect(res.statusCode).toBe(409);
    expect(json(res)).toMatchObject({ placedOrders: 3, nextMilestoneAt: 6 });
  });

  it('rewards a backlog of milestones one per call, oldest first', async () => {
    await placeOrders(h.app, 7); // milestones 3 and 6 reached, 9 not yet

    const first = json(await generate());
    const second = json(await generate());
    const third = await generate();

    expect([first.milestoneOrderCount, second.milestoneOrderCount]).toEqual([3, 6]);
    expect(third.statusCode).toBe(409);
    expect(json(third).nextMilestoneAt).toBe(9);
  });

  it('mints exactly one coupon when admins request generation concurrently', async () => {
    await placeOrders(h.app, 3);

    const responses = await Promise.all(Array.from({ length: 8 }, () => generate()));

    expect(statusCounts(responses)).toEqual({ 201: 1, 409: 7 });
    expect(await countRows(h.db, 'coupons')).toBe(1);
  });
});

describe('coupon redemption', () => {
  it('applies a floored percentage to the subtotal and links the coupon to the order', async () => {
    await placeOrders(h.app, 3);
    const code = await generateCoupon(h.app);
    const cartId = await createCart(h.app, { sticker: 1, cap: 3 }); // 4999 + 3 x 34950 = 109849

    const res = await checkout(h.app, cartId, 'with-coupon', code.toLowerCase());

    expect(res.statusCode).toBe(201);
    const order = json(res);
    expect(order).toMatchObject({
      subtotalPaise: 109_849,
      discountPaise: 10_984, // floor(10984.9)
      totalPaise: 98_865,
      coupon: { code, discountBps: 1_000, discountPercent: 10 },
    });
    expect(h.payments.charges.at(-1)?.amountPaise).toBe(98_865);
    expect(await couponRow(code)).toMatchObject({
      status: 'REDEEMED',
      redeemed_order_id: order.id,
    });
  });

  it('lets only one of several concurrent checkouts redeem the same coupon', async () => {
    await placeOrders(h.app, 3);
    const code = await generateCoupon(h.app);
    const carts = await Promise.all(Array.from({ length: 5 }, () => createCart(h.app, { tee: 1 })));
    const teeStock = await stockOf(h.db, 'tee');

    const responses = await Promise.all(
      carts.map((cartId) => checkout(h.app, cartId, `k-${cartId}`, code)),
    );

    expect(statusCounts(responses)).toEqual({ 201: 1, 409: 4 });
    const winner = json(responses.find((r) => r.statusCode === 201)!);
    expect(winner.discountPaise).toBe(4_990);
    for (const loser of responses.filter((r) => r.statusCode === 409)) {
      expect(json(loser).code).toBe('COUPON_ALREADY_REDEEMED');
    }
    expect(await couponRow(code)).toMatchObject({
      status: 'REDEEMED',
      redeemed_order_id: winner.id,
    });
    expect(await stockOf(h.db, 'tee')).toBe(teeStock - 1); // losers sold nothing
  });

  it('keeps the coupon available when the checkout using it fails', async () => {
    await placeOrders(h.app, 3);
    const code = await generateCoupon(h.app);

    // Fails on inventory after the coupon was named.
    const tooMany = await createCart(h.app, { 'sneaker-ltd': 3 });
    await h.app.inject({
      method: 'PATCH',
      url: '/admin/products/sneaker-ltd',
      payload: { stockAdjustment: -1 },
    });
    expect(json(await checkout(h.app, tooMany, 'fail-stock', code)).code).toBe(
      'INSUFFICIENT_INVENTORY',
    );
    expect((await couponRow(code)).status).toBe('AVAILABLE');

    // Fails on payment after the coupon was claimed inside the transaction.
    h.payments.decline = () => 'card_expired';
    const declined = await createCart(h.app, { mug: 1 });
    expect((await checkout(h.app, declined, 'fail-pay', code)).statusCode).toBe(402);
    expect((await couponRow(code)).status).toBe('AVAILABLE');

    // Still redeemable afterwards.
    h.payments.decline = () => null;
    expect((await checkout(h.app, declined, 'fail-pay', code)).statusCode).toBe(201);
    expect((await couponRow(code)).status).toBe('REDEEMED');
  });

  it('hands the coupon to a waiting checkout when the holder fails mid-flight', async () => {
    await placeOrders(h.app, 3);
    const code = await generateCoupon(h.app);
    const doomed = await createCart(h.app, { hoodie: 1 });
    const hopeful = await createCart(h.app, { tee: 1 });
    // Decline only the hoodie charge (149900 - 10% = 134910).
    h.payments.decline = (req) => (req.amountPaise === 134_910 ? 'do_not_honour' : null);

    // `doomed` claims the coupon first and holds it while its payment is declined;
    // `hopeful` blocks on the coupon row and must win it once `doomed` rolls back.
    const doomedRes = checkout(h.app, doomed, 'doomed', code);
    await sleep(10);
    const hopefulRes = checkout(h.app, hopeful, 'hopeful', code);

    const [d, ok] = await Promise.all([doomedRes, hopefulRes]);
    expect(d.statusCode).toBe(402);
    expect(ok.statusCode).toBe(201);
    expect(json(ok).coupon.code).toBe(code);
    expect(await couponRow(code)).toMatchObject({
      status: 'REDEEMED',
      redeemed_order_id: json(ok).id,
    });
  });

  it('rejects unknown coupons without side effects', async () => {
    const cartId = await createCart(h.app, { tee: 1 });
    const res = await checkout(h.app, cartId, 'unknown-coupon', 'SAVE10-NOPE0000');
    expect(res.statusCode).toBe(422);
    expect(json(res).code).toBe('COUPON_NOT_FOUND');
    expect(await stockOf(h.db, 'tee')).toBe(100);
    expect(await countRows(h.db, 'orders')).toBe(0);
  });

  it('caps a 100% discount at a zero total and skips the charge', async () => {
    await placeOrders(h.app, 3);
    const charges = h.payments.charges.length;
    await h.db
      .insertInto('coupons')
      .values({
        code: 'FREE-TEST',
        milestone_index: 99,
        milestone_order_count: 999,
        discount_bps: 10_000,
        redeemed_order_id: null,
        redeemed_at: null,
      })
      .execute();
    const cartId = await createCart(h.app, { hoodie: 1 });

    const order = json(await checkout(h.app, cartId, 'free', 'free-test'));

    expect(order).toMatchObject({ subtotalPaise: 149_900, discountPaise: 149_900, totalPaise: 0 });
    expect(order.paymentReference).toBe('not-required:zero-total');
    expect(h.payments.charges.length).toBe(charges);
  });

  it('previews a discount on the cart view without reserving the coupon', async () => {
    await placeOrders(h.app, 3);
    const code = await generateCoupon(h.app);
    const cartId = await createCart(h.app, { sticker: 1 });

    const view = json(
      await h.app.inject({ method: 'GET', url: `/carts/${cartId}?couponCode=${code}` }),
    );

    expect(view.couponPreview).toEqual({
      code,
      status: 'APPLICABLE',
      discountPercent: 10,
      discountPaise: 499,
      estimatedTotalPaise: 4_500,
    });
    expect((await couponRow(code)).status).toBe('AVAILABLE');
  });
});
