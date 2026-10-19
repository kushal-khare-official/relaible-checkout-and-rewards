import type { Db } from '../../db/database.js';
import type { ProductRow } from '../../db/types.js';
import { Errors } from '../../domain/errors.js';

export interface ProductView {
  id: string;
  name: string;
  unitPricePaise: number;
  stock: number;
  updatedAt: string;
}

export function toProductView(row: ProductRow): ProductView {
  return {
    id: row.id,
    name: row.name,
    unitPricePaise: row.price_paise,
    stock: row.stock,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class ProductService {
  constructor(private readonly db: Db) {}

  async list(): Promise<ProductView[]> {
    const rows = await this.db.selectFrom('products').selectAll().orderBy('id').execute();
    return rows.map(toProductView);
  }

  async get(productId: string): Promise<ProductView> {
    const row = await this.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', productId)
      .executeTakeFirst();
    if (!row) throw Errors.productNotFound(productId);
    return toProductView(row);
  }
}
