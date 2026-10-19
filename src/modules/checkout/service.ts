import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../../db/database.js';
import { lockCart, setLockTimeout } from '../../db/locks.js';
import { normalizeCouponCode } from '../../domain/coupon-code.js';
import { Errors, type PriceChange, type Shortage } from '../../domain/errors.js';
import { CURRENCY } from '../../domain/money.js';
import { priceOrder } from '../../domain/pricing.js';
import { PaymentDeclinedError, type PaymentGateway } from '../../payments/gateway.js';
import { toOrderView, type OrderView } from '../orders/service.js';
import { claimKey, completeKey, fingerprint } from './idempotency.js';

export const CHECKOUT_SCOPE = 'checkout';

export interface CheckoutInput {
  cartId: string;
  couponCode?: string;
  idempotencyKey: string;
}

export type CheckoutResult =
  | { replayed: false; status: 201; order: OrderView }
  | { replayed: true; status: number; order: OrderView };

/** Test seams for widening race windows; no-ops in production. */
export interface CheckoutHooks {
  afterProductsLocked?: () => Promise<void>;
}

export class CheckoutService {
  constructor(
    private readonly db: Db,
    private readonly payments: PaymentGateway,
    private readonly hooks: CheckoutHooks = {},
  ) {}

  /**
   * One transaction, locks always taken in the same order (idempotency key -> cart ->
   * products by id -> coupon) so concurrent checkouts can block each other but never
   * deadlock. Every check happens before any write; any thrown error rolls back the whole
   * attempt, so a failed checkout leaves stock, coupon and idempotency key untouched.
   */
  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const couponCode =
      input.couponCode === undefined ? null : normalizeCouponCode(input.couponCode);
    const requestHash = fingerprint({ cartId: input.cartId, couponCode });

    return this.db.transaction().execute(async (trx) => {
      await setLockTimeout(trx);

      // 1. Idempotency: replay a completed request instead of running it again.
      const claim = await claimKey(trx, CHECKOUT_SCOPE, input.idempotencyKey, requestHash);
      if (claim.kind === 'replay') {
        return { replayed: true, status: claim.status, order: claim.body as OrderView };
      }

      // 2. The cart: one checkout per cart, regardless of idempotency keys.
      const cart = await lockCart(trx, input.cartId);
      if (cart.status !== 'OPEN') throw Errors.cartAlreadyCheckedOut(cart.id, cart.order_id);
      const items = await trx
        .selectFrom('cart_items')
        .selectAll()
        .where('cart_id', '=', cart.id)
        .orderBy('product_id')
        .execute();
      if (items.length === 0) throw Errors.cartEmpty(cart.id);

      // 3. Lock every product row we will decrement, in id order (deadlock-free). NO KEY UPDATE
      // is the strength an UPDATE of non-key columns needs: it still serialises checkouts, but
      // does not block shoppers whose add-to-cart takes a KEY SHARE lock via the foreign key.
      const products = await trx
        .selectFrom('products')
        .selectAll()
        .where(
          'id',
          'in',
          items.map((i) => i.product_id),
        )
        .orderBy('id')
        .forNoKeyUpdate()
        .execute();
      await this.hooks.afterProductsLocked?.();
      const productById = new Map(products.map((p) => [p.id, p]));

      // 4. Validate everything against the locked rows, reporting all problems at once.
      const shortages: Shortage[] = [];
      const changes: PriceChange[] = [];
      for (const item of items) {
        const product = productById.get(item.product_id)!; // FK guarantees existence
        if (product.stock < item.quantity) {
          shortages.push({
            productId: product.id,
            requested: item.quantity,
            available: product.stock,
          });
        }
        if (product.price_paise !== item.acknowledged_price_paise) {
          changes.push({
            productId: product.id,
            acknowledgedUnitPricePaise: item.acknowledged_price_paise,
            currentUnitPricePaise: product.price_paise,
          });
        }
      }
      if (shortages.length > 0) throw Errors.insufficientInventory(shortages);
      if (changes.length > 0) throw Errors.priceChanged(changes);

      // 5. Claim the coupon (if any). Lock order: after products.
      const orderId = randomUUID();
      const discountBps = couponCode === null ? null : await redeemCoupon(trx, couponCode, orderId);

      // 6. Price from the locked snapshot.
      const pricing = priceOrder(
        items.map((item) => {
          const product = productById.get(item.product_id)!;
          return {
            productId: product.id,
            productName: product.name,
            unitPricePaise: product.price_paise,
            quantity: item.quantity,
          };
        }),
        discountBps,
      );

      // 7. Charge. A decline throws and rolls back the coupon claim and everything above.
      const paymentReference =
        pricing.totalPaise === 0
          ? 'not-required:zero-total'
          : await this.charge(orderId, pricing.totalPaise, input.idempotencyKey);

      // 8. Effects. The guarded decrement cannot miss while we hold the row locks; checking
      // the row count anyway turns a broken assumption into a rollback, not an oversell.
      for (const line of pricing.lines) {
        const result = await trx
          .updateTable('products')
          .set((eb) => ({ stock: eb('stock', '-', line.quantity), updated_at: new Date() }))
          .where('id', '=', line.productId)
          .where('stock', '>=', line.quantity)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw new Error(`Invariant violated: stock for ${line.productId} changed under lock`);
        }
      }

      const order = await trx
        .insertInto('orders')
        .values({
          id: orderId,
          cart_id: cart.id,
          currency: CURRENCY,
          subtotal_paise: pricing.subtotalPaise,
          discount_paise: pricing.discountPaise,
          total_paise: pricing.totalPaise,
          coupon_code: couponCode,
          discount_bps: discountBps,
          payment_reference: paymentReference,
          idempotency_key: input.idempotencyKey,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const orderItems = await trx
        .insertInto('order_items')
        .values(
          pricing.lines.map((line) => ({
            order_id: orderId,
            product_id: line.productId,
            product_name: line.productName,
            unit_price_paise: line.unitPricePaise,
            quantity: line.quantity,
            line_total_paise: line.lineTotalPaise,
          })),
        )
        .returningAll()
        .execute();
      await trx
        .updateTable('carts')
        .set({ status: 'CHECKED_OUT', order_id: orderId, updated_at: new Date() })
        .where('id', '=', cart.id)
        .where('status', '=', 'OPEN')
        .execute();

      const view = toOrderView(order, orderItems);
      await completeKey(trx, CHECKOUT_SCOPE, input.idempotencyKey, 201, view);
      return { replayed: false, status: 201, order: view };
    });
  }

  private async charge(orderId: string, amountPaise: number, idempotencyKey: string) {
    try {
      const result = await this.payments.charge({
        orderId,
        amountPaise,
        currency: CURRENCY,
        idempotencyKey,
      });
      return result.reference;
    } catch (error) {
      if (error instanceof PaymentDeclinedError) throw Errors.paymentDeclined(error.reason);
      throw error;
    }
  }
}

/**
 * Compare-and-set on the coupon row. A concurrent redeemer blocks on the row lock; once the
 * winner commits, Postgres re-evaluates `status = 'AVAILABLE'` against the new row version
 * and the loser updates nothing. If the winner rolls back, the loser proceeds, so a coupon
 * is never lost to a checkout that ultimately failed.
 */
async function redeemCoupon(trx: Tx, code: string, orderId: string): Promise<number> {
  const redeemed = await trx
    .updateTable('coupons')
    .set({ status: 'REDEEMED', redeemed_order_id: orderId, redeemed_at: new Date() })
    .where('code', '=', code)
    .where('status', '=', 'AVAILABLE')
    .returning('discount_bps')
    .executeTakeFirst();
  if (redeemed) return redeemed.discount_bps;

  const exists = await trx
    .selectFrom('coupons')
    .select('code')
    .where('code', '=', code)
    .executeTakeFirst();
  throw exists ? Errors.couponAlreadyRedeemed(code) : Errors.couponNotFound(code);
}
