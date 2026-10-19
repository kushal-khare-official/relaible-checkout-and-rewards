import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkout,
  countRows,
  createCart,
  createHarness,
  json,
  resetDatabase,
  sleep,
  statusCounts,
  stockOf,
  type TestHarness,
} from '../setup/helpers.js';

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h.db);
  // Hold the product locks for a while so concurrent checkouts genuinely overlap. A
  // read-check-write implementation without row locks oversells reliably under this hook.
  h.hooks.afterProductsLocked = () => sleep(25);
});

describe('concurrent checkouts never oversell', () => {
  it('sells exactly the 3 limited sneakers to 10 simultaneous buyers', async () => {
    const carts = await Promise.all(
      Array.from({ length: 10 }, () => createCart(h.app, { 'sneaker-ltd': 1 })),
    );

    const responses = await Promise.all(
      carts.map((cartId) => checkout(h.app, cartId, `k-${cartId}`)),
    );

    expect(statusCounts(responses)).toEqual({ 201: 3, 409: 7 });
    for (const loser of responses.filter((r) => r.statusCode === 409)) {
      expect(json(loser)).toMatchObject({
        code: 'INSUFFICIENT_INVENTORY',
        shortages: [{ productId: 'sneaker-ltd', requested: 1, available: 0 }],
      });
    }
    expect(await stockOf(h.db, 'sneaker-ltd')).toBe(0);
    expect(await countRows(h.db, 'orders')).toBe(3);
  });

  it('is all-or-nothing per order when quantities do not divide the stock', async () => {
    // Stock 3, each buyer wants 2: only one can be served, nobody gets a partial order.
    const carts = await Promise.all(
      Array.from({ length: 5 }, () => createCart(h.app, { 'sneaker-ltd': 2, tee: 1 })),
    );

    const responses = await Promise.all(
      carts.map((cartId) => checkout(h.app, cartId, `k-${cartId}`)),
    );

    expect(statusCounts(responses)).toEqual({ 201: 1, 409: 4 });
    expect(await stockOf(h.db, 'sneaker-ltd')).toBe(1);
    expect(await stockOf(h.db, 'tee')).toBe(99); // losers did not consume tees either
  });

  it('does not deadlock when carts list the same products in different orders', async () => {
    // Cart lines are added in opposite orders; checkout locks products sorted by id, so
    // overlapping carts queue behind each other instead of deadlocking (which would surface
    // as 503s or 500s).
    const forward = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const id = await createCart(h.app, { tee: 1 });
        await h.app.inject({
          method: 'PUT',
          url: `/carts/${id}/items/sneaker-ltd`,
          payload: { quantity: 1 },
        });
        return id;
      }),
    );
    const backward = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const id = await createCart(h.app, { 'sneaker-ltd': 1 });
        await h.app.inject({
          method: 'PUT',
          url: `/carts/${id}/items/tee`,
          payload: { quantity: 1 },
        });
        return id;
      }),
    );

    const responses = await Promise.all(
      [...forward, ...backward].map((cartId) => checkout(h.app, cartId, `k-${cartId}`)),
    );

    expect(statusCounts(responses)).toEqual({ 201: 3, 409: 9 });
    expect(await stockOf(h.db, 'sneaker-ltd')).toBe(0);
    expect(await stockOf(h.db, 'tee')).toBe(97);
  });

  it('never accepts a cart edit that is missing from the order placed concurrently', async () => {
    for (let round = 0; round < 5; round++) {
      const cartId = await createCart(h.app, { mug: 1 });

      const [checkoutRes, editRes] = await Promise.all([
        checkout(h.app, cartId, `k-${cartId}`),
        h.app.inject({
          method: 'PUT',
          url: `/carts/${cartId}/items/cap`,
          payload: { quantity: 2 },
        }),
      ]);

      expect(checkoutRes.statusCode).toBe(201);
      const orderedProducts = json(checkoutRes).items.map(
        (i: { productId: string }) => i.productId,
      );
      if (editRes.statusCode === 200) {
        // The edit committed first, so checkout must have seen it.
        expect(orderedProducts).toEqual(['cap', 'mug']);
      } else {
        // Checkout won the cart lock; the edit was refused rather than silently dropped.
        expect(editRes.statusCode).toBe(409);
        expect(json(editRes).code).toBe('CART_NOT_OPEN');
        expect(orderedProducts).toEqual(['mug']);
      }
    }
  });
});
