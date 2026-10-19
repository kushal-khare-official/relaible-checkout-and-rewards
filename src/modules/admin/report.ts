import { sql } from 'kysely';
import type { RewardConfig } from '../../config.js';
import type { Db } from '../../db/database.js';
import { CURRENCY } from '../../domain/money.js';

export interface SalesReport {
  currency: string;
  totalOrders: number;
  grossRevenuePaise: number;
  totalDiscountsPaise: number;
  netRevenuePaise: number;
  products: Array<{
    productId: string;
    name: string;
    quantitySold: number;
    grossRevenuePaise: number;
  }>;
  coupons: { generated: number; available: number; redeemed: number };
  rewards: {
    everyNOrders: number;
    discountPercent: number;
    rewardedMilestones: number;
    nextMilestoneAt: number;
    eligibleUnrewardedMilestones: number;
  };
}

/**
 * Pure read. All aggregates come from ONE repeatable-read snapshot, so the report is
 * internally consistent (gross - discounts = net, per-product sums = gross, redeemed coupons
 * = discounted orders) even while checkouts commit concurrently.
 */
export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly rewards: RewardConfig,
  ) {}

  async report(): Promise<SalesReport> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const products = await sql<{
          product_id: string;
          name: string;
          quantity_sold: number;
          gross_revenue_paise: number;
        }>`
          SELECT p.id AS product_id,
                 p.name,
                 COALESCE(SUM(oi.quantity), 0)         AS quantity_sold,
                 COALESCE(SUM(oi.line_total_paise), 0) AS gross_revenue_paise
          FROM products p
          LEFT JOIN order_items oi ON oi.product_id = p.id
          GROUP BY p.id, p.name
          ORDER BY p.id`.execute(trx);

        const totals = await sql<{
          total_orders: number;
          gross: number;
          discounts: number;
          net: number;
        }>`
          SELECT COUNT(*)                         AS total_orders,
                 COALESCE(SUM(subtotal_paise), 0) AS gross,
                 COALESCE(SUM(discount_paise), 0) AS discounts,
                 COALESCE(SUM(total_paise), 0)    AS net
          FROM orders`.execute(trx);

        const coupons = await sql<{
          generated: number;
          available: number;
          redeemed: number;
          last_milestone_order_count: number;
        }>`
          SELECT COUNT(*)                                       AS generated,
                 COUNT(*) FILTER (WHERE status = 'AVAILABLE')   AS available,
                 COUNT(*) FILTER (WHERE status = 'REDEEMED')    AS redeemed,
                 COALESCE(MAX(milestone_order_count), 0)        AS last_milestone_order_count
          FROM coupons`.execute(trx);

        const t = totals.rows[0]!;
        const c = coupons.rows[0]!;
        const n = this.rewards.everyNOrders;
        return {
          currency: CURRENCY,
          totalOrders: t.total_orders,
          grossRevenuePaise: t.gross,
          totalDiscountsPaise: t.discounts,
          netRevenuePaise: t.net,
          products: products.rows.map((p) => ({
            productId: p.product_id,
            name: p.name,
            quantitySold: p.quantity_sold,
            grossRevenuePaise: p.gross_revenue_paise,
          })),
          coupons: { generated: c.generated, available: c.available, redeemed: c.redeemed },
          rewards: {
            everyNOrders: n,
            discountPercent: this.rewards.discountBps / 100,
            rewardedMilestones: c.generated,
            nextMilestoneAt: c.last_milestone_order_count + n,
            eligibleUnrewardedMilestones: Math.max(
              0,
              Math.floor((t.total_orders - c.last_milestone_order_count) / n),
            ),
          },
        };
      });
  }
}
