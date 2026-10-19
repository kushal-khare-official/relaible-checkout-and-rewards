import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkout,
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

const patchProduct = (productId: string, payload: object) =>
  h.app.inject({ method: 'PATCH', url: `/admin/products/${productId}`, payload });
const viewCart = async (cartId: string) =>
  json(await h.app.inject({ method: 'GET', url: `/carts/${cartId}` }));

describe('price changes between add-to-cart and checkout', () => {
  it('refuses to charge an unacknowledged price, then honours it once acknowledged', async () => {
    const cartId = await createCart(h.app, { mug: 2 });
    await patchProduct('mug', { pricePaise: 31_900 });

    const view = await viewCart(cartId);
    expect(view.checkoutReady).toBe(false);
    expect(view.subtotalPaise).toBe(63_800); // live price
    expect(view.issues).toEqual([
      {
        code: 'PRICE_CHANGED',
        productId: 'mug',
        acknowledgedUnitPricePaise: 29_900,
        currentUnitPricePaise: 31_900,
      },
    ]);

    const refused = await checkout(h.app, cartId, 'drift');
    expect(refused.statusCode).toBe(409);
    expect(json(refused)).toMatchObject({
      code: 'PRICE_CHANGED',
      changes: [
        { productId: 'mug', acknowledgedUnitPricePaise: 29_900, currentUnitPricePaise: 31_900 },
      ],
    });
    expect(await stockOf(h.db, 'mug')).toBe(50);

    const acknowledged = json(
      await h.app.inject({ method: 'POST', url: `/carts/${cartId}/acknowledge-prices` }),
    );
    expect(acknowledged.checkoutReady).toBe(true);

    const placed = await checkout(h.app, cartId, 'drift'); // same key: the failure consumed nothing
    expect(placed.statusCode).toBe(201);
    expect(json(placed)).toMatchObject({ subtotalPaise: 63_800, totalPaise: 63_800 });
  });

  it('blocks on price decreases too: the customer pays exactly what they confirmed', async () => {
    const cartId = await createCart(h.app, { hoodie: 1 });
    await patchProduct('hoodie', { pricePaise: 99_900 });
    expect(json(await checkout(h.app, cartId, 'drop')).code).toBe('PRICE_CHANGED');
  });

  it('keeps the order snapshot when the catalogue changes later', async () => {
    const cartId = await createCart(h.app, { cap: 2 });
    const order = json(await checkout(h.app, cartId, 'snap'));

    await patchProduct('cap', { pricePaise: 1_000 });
    const fetched = json(await h.app.inject({ method: 'GET', url: `/orders/${order.id}` }));

    expect(fetched).toEqual(order);
    expect(fetched.items).toEqual([
      {
        productId: 'cap',
        productName: 'Baseball Cap',
        unitPricePaise: 34_950,
        quantity: 2,
        lineTotalPaise: 69_900,
      },
    ]);
  });
});

describe('inventory changes and admin stock adjustments', () => {
  it('flags and rejects a cart whose stock dropped after it was filled', async () => {
    const cartId = await createCart(h.app, { 'sneaker-ltd': 3 });
    await patchProduct('sneaker-ltd', { stockAdjustment: -2 });

    expect((await viewCart(cartId)).issues).toEqual([
      { code: 'INSUFFICIENT_INVENTORY', productId: 'sneaker-ltd', requested: 3, available: 1 },
    ]);
    const res = await checkout(h.app, cartId, 'short');
    expect(res.statusCode).toBe(409);
    expect(json(res).shortages).toEqual([{ productId: 'sneaker-ltd', requested: 3, available: 1 }]);
  });

  it('applies restocks as deltas so concurrent sales are never overwritten', async () => {
    const carts = await Promise.all(
      Array.from({ length: 3 }, () => createCart(h.app, { 'sneaker-ltd': 1 })),
    );

    const responses = await Promise.all([
      ...carts.map((cartId) => checkout(h.app, cartId, `k-${cartId}`)),
      patchProduct('sneaker-ltd', { stockAdjustment: 10 }),
    ]);

    expect(statusCounts(responses)).toEqual({ 201: 3, 200: 1 });
    expect(await stockOf(h.db, 'sneaker-ltd')).toBe(3 + 10 - 3);
  });

  it('refuses an adjustment that would make stock negative', async () => {
    const res = await patchProduct('sneaker-ltd', { stockAdjustment: -4 });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toMatchObject({ code: 'STOCK_WOULD_BE_NEGATIVE', stock: 3, adjustment: -4 });
    expect(await stockOf(h.db, 'sneaker-ltd')).toBe(3);
  });
});

describe('cart validation', () => {
  it('keeps invalid products and quantities out of the cart', async () => {
    const cartId = await createCart(h.app, {});
    const add = (payload: object) =>
      h.app.inject({ method: 'POST', url: `/carts/${cartId}/items`, payload });

    for (const quantity of [0, -1, 1.5, 101, '2']) {
      const res = await add({ productId: 'tee', quantity });
      expect(res.statusCode, `quantity ${quantity}`).toBe(400);
      expect(json(res).code).toBe('VALIDATION_FAILED');
    }
    expect(json(await add({ productId: 'nope', quantity: 1 }))).toMatchObject({
      status: 422,
      code: 'PRODUCT_NOT_FOUND',
    });
    expect(json(await add({ productId: 'sneaker-ltd', quantity: 4 }))).toMatchObject({
      status: 409,
      code: 'INSUFFICIENT_INVENTORY',
    });

    expect((await add({ productId: 'tee', quantity: 60 })).statusCode).toBe(200);
    const over = await add({ productId: 'tee', quantity: 41 }); // 60 + 41 > 100 per line
    expect(json(over)).toMatchObject({ status: 422, code: 'QUANTITY_LIMIT_EXCEEDED' });

    const view = await viewCart(cartId);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ productId: 'tee', quantity: 60 });
  });

  it('adds to a line with POST, sets it with PUT, and removes idempotently with DELETE', async () => {
    const cartId = await createCart(h.app, { tee: 1 });
    const url = `/carts/${cartId}/items`;

    await h.app.inject({ method: 'POST', url, payload: { productId: 'tee', quantity: 2 } });
    expect((await viewCart(cartId)).items[0].quantity).toBe(3);

    for (let i = 0; i < 2; i++) {
      await h.app.inject({ method: 'PUT', url: `${url}/tee`, payload: { quantity: 5 } });
    }
    expect((await viewCart(cartId)).items[0].quantity).toBe(5);

    for (let i = 0; i < 2; i++) {
      expect((await h.app.inject({ method: 'DELETE', url: `${url}/tee` })).statusCode).toBe(200);
    }
    expect((await viewCart(cartId)).items).toEqual([]);
  });

  it('rejects checkout of an empty cart and of unknown carts', async () => {
    const cartId = await createCart(h.app, {});
    expect(json(await checkout(h.app, cartId, 'empty'))).toMatchObject({
      status: 422,
      code: 'CART_EMPTY',
    });
    const missing = await checkout(h.app, '00000000-0000-4000-8000-000000000000', 'missing');
    expect(json(missing)).toMatchObject({ status: 404, code: 'CART_NOT_FOUND' });
  });
});
