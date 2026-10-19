import type { ColumnType, Generated, Selectable } from 'kysely';

/** All money columns are BIGINT minor units (paise); see database.ts for the safe-integer parser. */
type Paise = number;

export type CartStatus = 'OPEN' | 'CHECKED_OUT';
export type CouponStatus = 'AVAILABLE' | 'REDEEMED';

export interface ProductsTable {
  id: string;
  name: string;
  price_paise: Paise;
  stock: number;
  updated_at: Generated<Date>;
}

export interface CartsTable {
  id: Generated<string>;
  status: Generated<CartStatus>;
  order_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CartItemsTable {
  cart_id: string;
  product_id: string;
  quantity: number;
  /** The unit price the client last saw for this line; checkout refuses to charge anything else. */
  acknowledged_price_paise: Paise;
  added_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrdersTable {
  id: string;
  cart_id: string;
  status: Generated<'PLACED'>;
  currency: Generated<string>;
  subtotal_paise: Paise;
  discount_paise: Paise;
  total_paise: Paise;
  coupon_code: string | null;
  discount_bps: number | null;
  payment_reference: string;
  idempotency_key: string;
  placed_at: Generated<Date>;
}

export interface OrderItemsTable {
  order_id: string;
  product_id: string;
  product_name: string;
  unit_price_paise: Paise;
  quantity: number;
  line_total_paise: Paise;
}

export interface CouponsTable {
  code: string;
  milestone_index: number;
  milestone_order_count: number;
  discount_bps: number;
  status: Generated<CouponStatus>;
  redeemed_order_id: string | null;
  created_at: Generated<Date>;
  redeemed_at: Date | null;
}

export interface IdempotencyKeysTable {
  scope: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  /** Written as a JSON string, read back as parsed JSON. */
  response_body: ColumnType<unknown, string | null, string | null>;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface Database {
  products: ProductsTable;
  carts: CartsTable;
  cart_items: CartItemsTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  coupons: CouponsTable;
  idempotency_keys: IdempotencyKeysTable;
}

export type ProductRow = Selectable<ProductsTable>;
export type CartRow = Selectable<CartsTable>;
export type CartItemRow = Selectable<CartItemsTable>;
export type OrderRow = Selectable<OrdersTable>;
export type OrderItemRow = Selectable<OrderItemsTable>;
export type CouponRow = Selectable<CouponsTable>;
