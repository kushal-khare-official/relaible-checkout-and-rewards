import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkout,
  countRows,
  createCart,
  createHarness,
  json,
  resetHarness,
  statusCounts,
  stockOf,
  type TestHarness,
} from '../setup/helpers.js';

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => resetHarness(h));

describe('checkout retries', () => {
  it('turns a storm of identical retries into exactly one order and one charge', async () => {
    const cartId = await createCart(h.app, { 'sneaker-ltd': 2 });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => checkout(h.app, cartId, 'retry-storm')),
    );

    expect(statusCounts(responses)).toEqual({ 201: 5 });
    const orderIds = new Set(responses.map((r) => json(r).id));
    expect(orderIds.size).toBe(1);
    // Every response is byte-identical to the original; four of them are replays.
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
    expect(await countRows(h.db, 'orders')).toBe(1);
    expect(await stockOf(h.db, 'sneaker-ltd')).toBe(1);
    expect(h.payments.charges).toHaveLength(1);
  });

  it('allows one order per cart even when retries use different keys', async () => {
    const cartId = await createCart(h.app, { tee: 1 });

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => checkout(h.app, cartId, `distinct-key-${i}`)),
    );

    expect(statusCounts(responses)).toEqual({ 201: 1, 409: 4 });
    const winner = json(responses.find((r) => r.statusCode === 201)!);
    for (const loser of responses.filter((r) => r.statusCode === 409)) {
      // The client learns which order already exists and can fetch it.
      expect(json(loser)).toMatchObject({ code: 'CART_ALREADY_CHECKED_OUT', orderId: winner.id });
    }
    expect(await stockOf(h.db, 'tee')).toBe(99);
  });

  it('rejects reuse of a key for a different request', async () => {
    const cartA = await createCart(h.app, { tee: 1 });
    const cartB = await createCart(h.app, { tee: 1 });
    expect((await checkout(h.app, cartA, 'shared-key')).statusCode).toBe(201);

    const otherCart = await checkout(h.app, cartB, 'shared-key');
    expect(otherCart.statusCode).toBe(422);
    expect(json(otherCart).code).toBe('IDEMPOTENCY_KEY_REUSED');

    const otherCoupon = await checkout(h.app, cartA, 'shared-key', 'SAVE10-ANYTHING');
    expect(otherCoupon.statusCode).toBe(422);
    expect(await countRows(h.db, 'orders')).toBe(1);
  });

  it('does not consume the key, stock or anything else when payment is declined', async () => {
    const cartId = await createCart(h.app, { 'sneaker-ltd': 1 });
    h.payments.decline = () => 'insufficient_funds';

    const declined = await checkout(h.app, cartId, 'pay-attempt-1');
    expect(declined.statusCode).toBe(402);
    expect(json(declined)).toMatchObject({
      code: 'PAYMENT_DECLINED',
      reason: 'insufficient_funds',
    });
    expect(await stockOf(h.db, 'sneaker-ltd')).toBe(3);
    expect(await countRows(h.db, 'orders')).toBe(0);
    expect(await countRows(h.db, 'idempotency_keys')).toBe(0);

    // Same key retried once the customer fixes their payment method: it now succeeds.
    h.payments.decline = () => null;
    const retried = await checkout(h.app, cartId, 'pay-attempt-1');
    expect(retried.statusCode).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
    expect(await stockOf(h.db, 'sneaker-ltd')).toBe(2);
  });

  it('requires a key', async () => {
    const cartId = await createCart(h.app, { tee: 1 });
    const res = await h.app.inject({ method: 'POST', url: `/carts/${cartId}/checkout` });
    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await countRows(h.db, 'orders')).toBe(0);
  });
});
