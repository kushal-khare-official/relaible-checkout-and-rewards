import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

/**
 * Schema constraints are the last line of defence for the business invariants: even if a
 * code path forgets a check, the database refuses the write. The comments name the invariant
 * (see DECISIONS.md) each constraint protects.
 */
const initStatements = [
  `CREATE TABLE products (
     id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,64}$'),
     name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
     price_paise bigint NOT NULL CHECK (price_paise > 0 AND price_paise <= 1000000000),
     stock       integer NOT NULL CONSTRAINT products_stock_non_negative CHECK (stock >= 0), -- I1
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE carts (
     id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     status     text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CHECKED_OUT')),
     order_id   uuid NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT carts_checked_out_has_order CHECK ((status = 'CHECKED_OUT') = (order_id IS NOT NULL)),
     CONSTRAINT carts_id_order_id_key UNIQUE (id, order_id)
   )`,

  `CREATE TABLE cart_items (
     cart_id                  uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
     product_id               text NOT NULL REFERENCES products(id),
     quantity                 integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
     acknowledged_price_paise bigint NOT NULL CHECK (acknowledged_price_paise > 0),
     added_at                 timestamptz NOT NULL DEFAULT now(),
     updated_at               timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (cart_id, product_id)
   )`,

  `CREATE TABLE coupons (
     code                  text PRIMARY KEY,
     milestone_index       integer NOT NULL CHECK (milestone_index >= 1),
     milestone_order_count integer NOT NULL CHECK (milestone_order_count >= 1),
     discount_bps          integer NOT NULL CHECK (discount_bps BETWEEN 1 AND 10000),
     status                text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'REDEEMED')),
     redeemed_order_id     uuid NULL,
     created_at            timestamptz NOT NULL DEFAULT now(),
     redeemed_at           timestamptz NULL,
     CONSTRAINT coupons_milestone_index_key UNIQUE (milestone_index),             -- I7
     CONSTRAINT coupons_milestone_order_count_key UNIQUE (milestone_order_count), -- I7
     CONSTRAINT coupons_redeemed_order_id_key UNIQUE (redeemed_order_id),         -- I5
     CONSTRAINT coupons_code_redeemed_order_key UNIQUE (code, redeemed_order_id),
     CONSTRAINT coupons_redemption_consistency CHECK (
       (status = 'REDEEMED') = (redeemed_order_id IS NOT NULL AND redeemed_at IS NOT NULL))
   )`,

  `CREATE TABLE orders (
     id                uuid PRIMARY KEY,
     cart_id           uuid NOT NULL REFERENCES carts(id),
     status            text NOT NULL DEFAULT 'PLACED' CHECK (status = 'PLACED'),
     currency          text NOT NULL DEFAULT 'INR',
     subtotal_paise    bigint NOT NULL CHECK (subtotal_paise >= 0),
     discount_paise    bigint NOT NULL CHECK (discount_paise >= 0 AND discount_paise <= subtotal_paise),
     total_paise       bigint NOT NULL,
     coupon_code       text NULL REFERENCES coupons(code),
     discount_bps      integer NULL CHECK (discount_bps BETWEEN 1 AND 10000),
     payment_reference text NOT NULL,
     idempotency_key   text NOT NULL,
     placed_at         timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT orders_cart_id_key UNIQUE (cart_id),                -- I2: one order per cart
     CONSTRAINT orders_coupon_code_key UNIQUE (coupon_code),        -- I5: one order per coupon
     CONSTRAINT orders_id_cart_id_key UNIQUE (id, cart_id),
     CONSTRAINT orders_id_coupon_code_key UNIQUE (id, coupon_code),
     CONSTRAINT orders_total_arithmetic CHECK (total_paise = subtotal_paise - discount_paise), -- I8
     CONSTRAINT orders_coupon_fields_together CHECK ((coupon_code IS NULL) = (discount_bps IS NULL)),
     CONSTRAINT orders_no_discount_without_coupon CHECK (coupon_code IS NOT NULL OR discount_paise = 0)
   )`,

  // Two-way links, checked at COMMIT so either row may be written first inside the checkout
  // transaction. Together they make "cart CHECKED_OUT <=> exactly one order for it" and
  // "coupon REDEEMED <=> exactly one order used it" database-enforced facts.
  `ALTER TABLE carts ADD CONSTRAINT carts_order_link_fkey
     FOREIGN KEY (order_id, id) REFERENCES orders (id, cart_id) DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE orders ADD CONSTRAINT orders_cart_link_fkey
     FOREIGN KEY (cart_id, id) REFERENCES carts (id, order_id) DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE coupons ADD CONSTRAINT coupons_order_link_fkey
     FOREIGN KEY (redeemed_order_id, code) REFERENCES orders (id, coupon_code) DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE orders ADD CONSTRAINT orders_coupon_link_fkey
     FOREIGN KEY (coupon_code, id) REFERENCES coupons (code, redeemed_order_id) DEFERRABLE INITIALLY DEFERRED`,

  `CREATE TABLE order_items (
     order_id         uuid NOT NULL REFERENCES orders(id),
     product_id       text NOT NULL REFERENCES products(id),
     product_name     text NOT NULL,
     unit_price_paise bigint NOT NULL CHECK (unit_price_paise > 0),
     quantity         integer NOT NULL CHECK (quantity > 0),
     line_total_paise bigint NOT NULL,
     PRIMARY KEY (order_id, product_id),
     CONSTRAINT order_items_line_arithmetic CHECK (line_total_paise = unit_price_paise * quantity) -- I8
   )`,
  `CREATE INDEX order_items_product_id_idx ON order_items (product_id)`,
  `CREATE INDEX orders_placed_at_idx ON orders (placed_at, id)`,

  `CREATE TABLE idempotency_keys (
     scope           text NOT NULL,
     key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
     request_hash    text NOT NULL,
     response_status integer NULL,
     response_body   jsonb NULL,
     created_at      timestamptz NOT NULL DEFAULT now(),
     completed_at    timestamptz NULL,
     PRIMARY KEY (scope, key)                                       -- I4
   )`,
];

const migrations: Record<string, Migration> = {
  '001_init': {
    async up(db) {
      for (const statement of initStatements) {
        await sql.raw(statement).execute(db);
      }
    },
  },
};

class InlineMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const migrator = new Migrator({ db, provider: new InlineMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) {
    throw new Error(`Migration failed${failed ? ` at ${failed.migrationName}` : ''}`, {
      cause: error,
    });
  }
}
