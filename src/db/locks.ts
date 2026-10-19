import { sql } from 'kysely';
import type { Tx } from './database.js';
import type { CartRow } from './types.js';
import { Errors } from '../domain/errors.js';

/**
 * Bound how long a request waits behind another transaction's row lock. Hitting it surfaces as
 * 503 LOCK_TIMEOUT (retryable) instead of a request that hangs until the client gives up.
 */
export async function setLockTimeout(trx: Tx, ms = 5_000): Promise<void> {
  await sql`SELECT set_config('lock_timeout', ${`${ms}ms`}, true)`.execute(trx);
}

/**
 * Every cart mutation and checkout starts by locking the cart row, so for one cart they are
 * strictly serialised: an item change either commits before checkout (and is in the order)
 * or runs after it (and is rejected because the cart is no longer OPEN). Never lost.
 */
export async function lockCart(trx: Tx, cartId: string): Promise<CartRow> {
  const cart = await trx
    .selectFrom('carts')
    .selectAll()
    .where('id', '=', cartId)
    .forUpdate()
    .executeTakeFirst();
  if (!cart) throw Errors.cartNotFound(cartId);
  return cart;
}
