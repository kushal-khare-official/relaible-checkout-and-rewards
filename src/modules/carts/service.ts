import type { Kysely } from 'kysely';
import type { Db, Tx } from '../../db/database.js';
import { lockCart, setLockTimeout } from '../../db/locks.js';
import type { CartRow, Database } from '../../db/types.js';
import { normalizeCouponCode } from '../../domain/coupon-code.js';
import { Errors } from '../../domain/errors.js';
import { CURRENCY } from '../../domain/money.js';
import { MAX_LINE_QUANTITY, priceOrder } from '../../domain/pricing.js';

export interface CartLineView {
  productId: string;
  name: string;
  quantity: number;
  /** Current catalogue price: what checkout will charge once acknowledged. */
  unitPricePaise: number;
  /** Price the client last saw for this line. */
  acknowledgedUnitPricePaise: number;
  priceChanged: boolean;
  lineTotalPaise: number;
  availableStock: number;
  sufficientStock: boolean;
}

export type CartIssue =
  | {
      code: 'PRICE_CHANGED';
      productId: string;
      acknowledgedUnitPricePaise: number;
      currentUnitPricePaise: number;
    }
  | { code: 'INSUFFICIENT_INVENTORY'; productId: string; requested: number; available: number };

export interface CouponPreview {
  code: string;
  status: 'APPLICABLE' | 'NOT_FOUND' | 'ALREADY_REDEEMED';
  discountPercent: number | null;
  discountPaise: number;
  estimatedTotalPaise: number;
}

export interface CartView {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT';
  orderId: string | null;
  currency: string;
  items: CartLineView[];
  itemCount: number;
  subtotalPaise: number;
  /** Problems checkout would currently reject; empty when checkoutReady. */
  issues: CartIssue[];
  checkoutReady: boolean;
  couponPreview?: CouponPreview;
  createdAt: string;
  updatedAt: string;
}

interface LineRow {
  product_id: string;
  name: string;
  quantity: number;
  acknowledged_price_paise: number;
  price_paise: number;
  stock: number;
}

async function loadLines(db: Kysely<Database>, cartId: string): Promise<LineRow[]> {
  return db
    .selectFrom('cart_items as ci')
    .innerJoin('products as p', 'p.id', 'ci.product_id')
    .select([
      'ci.product_id',
      'p.name',
      'ci.quantity',
      'ci.acknowledged_price_paise',
      'p.price_paise',
      'p.stock',
    ])
    .where('ci.cart_id', '=', cartId)
    .orderBy('ci.product_id')
    .execute();
}

function toCartView(cart: CartRow, lines: LineRow[]): CartView {
  const items: CartLineView[] = lines.map((l) => ({
    productId: l.product_id,
    name: l.name,
    quantity: l.quantity,
    unitPricePaise: l.price_paise,
    acknowledgedUnitPricePaise: l.acknowledged_price_paise,
    priceChanged: l.price_paise !== l.acknowledged_price_paise,
    lineTotalPaise: l.price_paise * l.quantity,
    availableStock: l.stock,
    sufficientStock: l.stock >= l.quantity,
  }));
  const pricing = priceOrder(toLineInputs(lines), null);
  const issues: CartIssue[] = [];
  for (const item of items) {
    if (item.priceChanged) {
      issues.push({
        code: 'PRICE_CHANGED',
        productId: item.productId,
        acknowledgedUnitPricePaise: item.acknowledgedUnitPricePaise,
        currentUnitPricePaise: item.unitPricePaise,
      });
    }
    if (!item.sufficientStock) {
      issues.push({
        code: 'INSUFFICIENT_INVENTORY',
        productId: item.productId,
        requested: item.quantity,
        available: item.availableStock,
      });
    }
  }
  return {
    id: cart.id,
    status: cart.status,
    orderId: cart.order_id,
    currency: CURRENCY,
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    subtotalPaise: pricing.subtotalPaise,
    issues,
    checkoutReady: cart.status === 'OPEN' && items.length > 0 && issues.length === 0,
    createdAt: cart.created_at.toISOString(),
    updatedAt: cart.updated_at.toISOString(),
  };
}

function toLineInputs(lines: LineRow[]) {
  return lines.map((l) => ({
    productId: l.product_id,
    productName: l.name,
    unitPricePaise: l.price_paise,
    quantity: l.quantity,
  }));
}

export class CartService {
  constructor(private readonly db: Db) {}

  async create(): Promise<CartView> {
    const cart = await this.db
      .insertInto('carts')
      .defaultValues()
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCartView(cart, []);
  }

  /** Read-only, from a single snapshot so the cart row and its lines agree. */
  async get(cartId: string, couponCode?: string): Promise<CartView> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const cart = await trx
          .selectFrom('carts')
          .selectAll()
          .where('id', '=', cartId)
          .executeTakeFirst();
        if (!cart) throw Errors.cartNotFound(cartId);
        const lines = await loadLines(trx, cartId);
        const view = toCartView(cart, lines);
        if (couponCode !== undefined) {
          view.couponPreview = await previewCoupon(trx, couponCode, lines);
        }
        return view;
      });
  }

  /** POST semantics: adds to any quantity already in the cart. */
  async addItem(cartId: string, productId: string, quantity: number): Promise<CartView> {
    return this.mutate(cartId, async (trx) => {
      const existing = await trx
        .selectFrom('cart_items')
        .select('quantity')
        .where('cart_id', '=', cartId)
        .where('product_id', '=', productId)
        .executeTakeFirst();
      await upsertLine(trx, cartId, productId, (existing?.quantity ?? 0) + quantity);
    });
  }

  /** PUT semantics: sets an absolute quantity, so retrying it is harmless. */
  async setItem(cartId: string, productId: string, quantity: number): Promise<CartView> {
    return this.mutate(cartId, (trx) => upsertLine(trx, cartId, productId, quantity));
  }

  /** Idempotent: removing a line that is not there still returns the cart. */
  async removeItem(cartId: string, productId: string): Promise<CartView> {
    return this.mutate(cartId, async (trx) => {
      await trx
        .deleteFrom('cart_items')
        .where('cart_id', '=', cartId)
        .where('product_id', '=', productId)
        .execute();
    });
  }

  /**
   * The client accepts current prices after seeing PRICE_CHANGED. The response carries the
   * newly acknowledged prices; that response is what the customer confirms at checkout.
   */
  async acknowledgePrices(cartId: string): Promise<CartView> {
    return this.mutate(cartId, async (trx) => {
      await trx
        .updateTable('cart_items')
        .from('products')
        .set((eb) => ({
          acknowledged_price_paise: eb.ref('products.price_paise'),
          updated_at: new Date(),
        }))
        .whereRef('cart_items.product_id', '=', 'products.id')
        .where('cart_items.cart_id', '=', cartId)
        .whereRef('cart_items.acknowledged_price_paise', '<>', 'products.price_paise')
        .execute();
    });
  }

  private async mutate(cartId: string, change: (trx: Tx) => Promise<void>): Promise<CartView> {
    return this.db.transaction().execute(async (trx) => {
      await setLockTimeout(trx);
      const cart = await lockCart(trx, cartId);
      if (cart.status !== 'OPEN') throw Errors.cartNotOpen(cartId, cart.order_id);
      await change(trx);
      const updated = await trx
        .updateTable('carts')
        .set({ updated_at: new Date() })
        .where('id', '=', cartId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toCartView(updated, await loadLines(trx, cartId));
    });
  }
}

/**
 * Validates a line against the catalogue and writes it. The stock check here is advisory
 * (fast feedback, nothing is reserved); checkout re-checks under row locks. Touching a line
 * re-acknowledges its current price, which the response shows to the client.
 */
async function upsertLine(trx: Tx, cartId: string, productId: string, quantity: number) {
  const product = await trx
    .selectFrom('products')
    .select(['price_paise', 'stock'])
    .where('id', '=', productId)
    .executeTakeFirst();
  if (!product) throw Errors.unknownProduct(productId);
  if (quantity > MAX_LINE_QUANTITY) {
    throw Errors.quantityLimitExceeded(productId, quantity, MAX_LINE_QUANTITY);
  }
  if (quantity > product.stock) {
    throw Errors.insufficientInventory([
      { productId, requested: quantity, available: product.stock },
    ]);
  }
  await trx
    .insertInto('cart_items')
    .values({
      cart_id: cartId,
      product_id: productId,
      quantity,
      acknowledged_price_paise: product.price_paise,
    })
    .onConflict((oc) =>
      oc.columns(['cart_id', 'product_id']).doUpdateSet({
        quantity,
        acknowledged_price_paise: product.price_paise,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** Read-only estimate; nothing is reserved, so the coupon can still be taken before checkout. */
async function previewCoupon(
  db: Kysely<Database>,
  rawCode: string,
  lines: LineRow[],
): Promise<CouponPreview> {
  const code = normalizeCouponCode(rawCode);
  const undiscounted = priceOrder(toLineInputs(lines), null);
  const coupon = await db
    .selectFrom('coupons')
    .select(['status', 'discount_bps'])
    .where('code', '=', code)
    .executeTakeFirst();
  if (!coupon || coupon.status === 'REDEEMED') {
    return {
      code,
      status: coupon ? 'ALREADY_REDEEMED' : 'NOT_FOUND',
      discountPercent: null,
      discountPaise: 0,
      estimatedTotalPaise: undiscounted.totalPaise,
    };
  }
  const discounted = priceOrder(toLineInputs(lines), coupon.discount_bps);
  return {
    code,
    status: 'APPLICABLE',
    discountPercent: coupon.discount_bps / 100,
    discountPaise: discounted.discountPaise,
    estimatedTotalPaise: discounted.totalPaise,
  };
}
