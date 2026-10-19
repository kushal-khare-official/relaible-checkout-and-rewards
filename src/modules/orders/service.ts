import type { Kysely } from 'kysely';
import type { Db } from '../../db/database.js';
import type { Database, OrderItemRow, OrderRow } from '../../db/types.js';
import { Errors } from '../../domain/errors.js';

export interface OrderLineView {
  productId: string;
  productName: string;
  unitPricePaise: number;
  quantity: number;
  lineTotalPaise: number;
}

/**
 * Everything needed to explain the charge without consulting the (mutable) catalogue:
 * snapshotted names and unit prices, the coupon and its rate, and each derived amount.
 */
export interface OrderView {
  id: string;
  cartId: string;
  status: 'PLACED';
  currency: string;
  items: OrderLineView[];
  subtotalPaise: number;
  coupon: { code: string; discountBps: number; discountPercent: number } | null;
  discountPaise: number;
  totalPaise: number;
  paymentReference: string;
  placedAt: string;
}

export function toOrderView(order: OrderRow, items: OrderItemRow[]): OrderView {
  return {
    id: order.id,
    cartId: order.cart_id,
    status: order.status,
    currency: order.currency,
    items: items.map((i) => ({
      productId: i.product_id,
      productName: i.product_name,
      unitPricePaise: i.unit_price_paise,
      quantity: i.quantity,
      lineTotalPaise: i.line_total_paise,
    })),
    subtotalPaise: order.subtotal_paise,
    coupon:
      order.coupon_code !== null && order.discount_bps !== null
        ? {
            code: order.coupon_code,
            discountBps: order.discount_bps,
            discountPercent: order.discount_bps / 100,
          }
        : null,
    discountPaise: order.discount_paise,
    totalPaise: order.total_paise,
    paymentReference: order.payment_reference,
    placedAt: order.placed_at.toISOString(),
  };
}

export async function loadOrderViews(
  db: Kysely<Database>,
  orders: OrderRow[],
): Promise<OrderView[]> {
  if (orders.length === 0) return [];
  const items = await db
    .selectFrom('order_items')
    .selectAll()
    .where(
      'order_id',
      'in',
      orders.map((o) => o.id),
    )
    .orderBy('product_id')
    .execute();
  return orders.map((o) =>
    toOrderView(
      o,
      items.filter((i) => i.order_id === o.id),
    ),
  );
}

export class OrderService {
  constructor(private readonly db: Db) {}

  async get(orderId: string): Promise<OrderView> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw Errors.orderNotFound(orderId);
    const [view] = await loadOrderViews(this.db, [order]);
    return view!;
  }

  async list(limit: number, offset: number): Promise<{ items: OrderView[]; total: number }> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const orders = await trx
          .selectFrom('orders')
          .selectAll()
          .orderBy('placed_at')
          .orderBy('id')
          .limit(limit)
          .offset(offset)
          .execute();
        const { total } = await trx
          .selectFrom('orders')
          .select((eb) => eb.fn.countAll<number>().as('total'))
          .executeTakeFirstOrThrow();
        return { items: await loadOrderViews(trx, orders), total };
      });
  }
}
