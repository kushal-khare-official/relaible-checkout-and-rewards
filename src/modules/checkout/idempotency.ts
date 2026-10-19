import { createHash } from 'node:crypto';
import type { Tx } from '../../db/database.js';
import { Errors } from '../../domain/errors.js';

export type KeyClaim = { kind: 'claimed' } | { kind: 'replay'; status: number; body: unknown };

/** Stable hash of the request's meaning, so a reused key with a different request is caught. */
export function fingerprint(payload: Record<string, string | null>): string {
  const canonical = JSON.stringify(
    Object.keys(payload)
      .sort()
      .map((k) => [k, payload[k]]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Claims `key` inside the caller's transaction, or returns the stored response of the request
 * that already used it.
 *
 * The claim is an INSERT on the primary key. If another transaction has inserted the same key
 * and not finished, Postgres makes this INSERT wait for it (bounded by lock_timeout):
 *   - the other commits  -> ON CONFLICT DO NOTHING inserts nothing; we read its response
 *   - the other rolls back (its checkout failed) -> our INSERT succeeds and we run for real
 * Because the claim shares the checkout transaction, a failed checkout never consumes a key.
 */
export async function claimKey(
  trx: Tx,
  scope: string,
  key: string,
  requestHash: string,
): Promise<KeyClaim> {
  const inserted = await trx
    .insertInto('idempotency_keys')
    .values({
      scope,
      key,
      request_hash: requestHash,
      response_status: null,
      response_body: null,
      completed_at: null,
    })
    .onConflict((oc) => oc.columns(['scope', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();
  if (inserted) return { kind: 'claimed' };

  const existing = await trx
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('scope', '=', scope)
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
  if (existing.request_hash !== requestHash) throw Errors.idempotencyKeyReused(key);
  if (existing.response_status === null) {
    // A committed claim always carries its response (both are written in one transaction).
    throw new Error(`Idempotency key ${key} committed without a response`);
  }
  return { kind: 'replay', status: existing.response_status, body: existing.response_body };
}

export async function completeKey(
  trx: Tx,
  scope: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await trx
    .updateTable('idempotency_keys')
    .set({ response_status: status, response_body: JSON.stringify(body), completed_at: new Date() })
    .where('scope', '=', scope)
    .where('key', '=', key)
    .execute();
}
