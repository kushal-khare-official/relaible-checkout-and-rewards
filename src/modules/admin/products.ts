import { sql } from 'kysely';
import type { Db } from '../../db/database.js';
import { Errors } from '../../domain/errors.js';
import { toProductView, type ProductView } from '../products/service.js';

export interface ProductAdjustment {
  pricePaise?: number;
  /** Signed delta (restock +n, write-off -n). Never an absolute value: see adjust(). */
  stockAdjustment?: number;
}

export class ProductAdminService {
  constructor(private readonly db: Db) {}

  /**
   * One atomic UPDATE. Stock moves by a delta computed against the row's current value, so
   * it composes with concurrent checkouts instead of overwriting their decrements (an
   * absolute "set stock to 20" would silently resurrect units sold a moment earlier).
   * A price change never touches placed orders (they hold snapshots); carts holding the
   * old price will get PRICE_CHANGED at checkout.
   */
  async adjust(productId: string, change: ProductAdjustment): Promise<ProductView> {
    const delta = change.stockAdjustment ?? 0;
    const updated = await this.db
      .updateTable('products')
      .set((eb) => ({
        price_paise: change.pricePaise ?? eb.ref('price_paise'),
        stock: eb('stock', '+', delta),
        updated_at: sql<Date>`now()`,
      }))
      .where('id', '=', productId)
      .where((eb) => eb(eb('stock', '+', delta), '>=', 0))
      .returningAll()
      .executeTakeFirst();
    if (updated) return toProductView(updated);

    const current = await this.db
      .selectFrom('products')
      .select('stock')
      .where('id', '=', productId)
      .executeTakeFirst();
    if (!current) throw Errors.productNotFound(productId);
    throw Errors.stockWouldBeNegative(productId, current.stock, delta);
  }
}
