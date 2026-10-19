import { sql } from 'kysely';
import type { RewardConfig } from '../../config.js';
import type { Db } from '../../db/database.js';
import type { CouponRow, CouponStatus } from '../../db/types.js';
import { generateCouponCode } from '../../domain/coupon-code.js';
import { Errors } from '../../domain/errors.js';

export interface CouponView {
  code: string;
  status: CouponStatus;
  discountBps: number;
  discountPercent: number;
  /** k-th reward milestone, reached when k * n orders had been placed (n at the time). */
  milestoneIndex: number;
  milestoneOrderCount: number;
  redeemedOrderId: string | null;
  createdAt: string;
  redeemedAt: string | null;
}

function toCouponView(row: CouponRow): CouponView {
  return {
    code: row.code,
    status: row.status,
    discountBps: row.discount_bps,
    discountPercent: row.discount_bps / 100,
    milestoneIndex: row.milestone_index,
    milestoneOrderCount: row.milestone_order_count,
    redeemedOrderId: row.redeemed_order_id,
    createdAt: row.created_at.toISOString(),
    redeemedAt: row.redeemed_at?.toISOString() ?? null,
  };
}

/** Arbitrary constant naming the "coupon generation" critical section. */
const COUPON_GENERATION_LOCK = 'coupon-generation';

export class CouponService {
  constructor(
    private readonly db: Db,
    private readonly rewards: RewardConfig,
  ) {}

  /**
   * Rewards the oldest unrewarded milestone, one coupon per call.
   *
   * Generators are serialised by a transaction-scoped advisory lock (works across app
   * instances, released automatically at commit/rollback), so two admins clicking at once
   * cannot both see "milestone 2 is free" and mint two coupons. UNIQUE(milestone_index) is
   * the backstop. Only committed orders count, so a milestone is never rewarded on the
   * strength of a checkout that later rolls back.
   */
  async generate(): Promise<CouponView> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${COUPON_GENERATION_LOCK}))`.execute(trx);

      const { placed } = await trx
        .selectFrom('orders')
        .select((eb) => eb.fn.countAll<number>().as('placed'))
        .executeTakeFirstOrThrow();
      const last = await trx
        .selectFrom('coupons')
        .select(['milestone_index', 'milestone_order_count'])
        .orderBy('milestone_index', 'desc')
        .limit(1)
        .executeTakeFirst();

      // Continue from the last rewarded milestone, so a change of n applies going forward
      // instead of re-interpreting history.
      const nextMilestoneAt = (last?.milestone_order_count ?? 0) + this.rewards.everyNOrders;
      if (placed < nextMilestoneAt) throw Errors.noEligibleMilestone(placed, nextMilestoneAt);

      const percent = this.rewards.discountBps / 100;
      for (let attempt = 0; attempt < 3; attempt++) {
        const created = await trx
          .insertInto('coupons')
          .values({
            code: generateCouponCode(percent),
            milestone_index: (last?.milestone_index ?? 0) + 1,
            milestone_order_count: nextMilestoneAt,
            discount_bps: this.rewards.discountBps,
            redeemed_order_id: null,
            redeemed_at: null,
          })
          // A random-code collision (40 bits) just draws again.
          .onConflict((oc) => oc.column('code').doNothing())
          .returningAll()
          .executeTakeFirst();
        if (created) return toCouponView(created);
      }
      throw new Error('Could not generate a unique coupon code');
    });
  }

  async list(status?: CouponStatus): Promise<CouponView[]> {
    let query = this.db.selectFrom('coupons').selectAll().orderBy('milestone_index');
    if (status) query = query.where('status', '=', status);
    return (await query.execute()).map(toCouponView);
  }
}
