import type { Db } from './database.js';

/**
 * Demo catalogue. Odd paise amounts (34950, 4999) exercise rounding; `sneaker-ltd` is the
 * deliberately scarce item used to demonstrate oversell protection.
 */
export const SEED_PRODUCTS = [
  { id: 'tee', name: 'Cotton T-Shirt', price_paise: 49_900, stock: 100 },
  { id: 'mug', name: 'Ceramic Mug', price_paise: 29_900, stock: 50 },
  { id: 'hoodie', name: 'Fleece Hoodie', price_paise: 149_900, stock: 25 },
  { id: 'cap', name: 'Baseball Cap', price_paise: 34_950, stock: 40 },
  { id: 'sticker', name: 'Sticker Pack', price_paise: 4_999, stock: 1_000 },
  { id: 'sneaker-ltd', name: 'Limited Edition Sneakers', price_paise: 799_900, stock: 3 },
] as const;

/** Idempotent: never overwrites price or stock of a product that already exists. */
export async function seedProducts(db: Db): Promise<void> {
  await db
    .insertInto('products')
    .values(SEED_PRODUCTS.map((p) => ({ ...p })))
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}
