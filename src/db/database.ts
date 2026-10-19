import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

// node-pg returns BIGINT (and COUNT/SUM over integers) as strings to avoid precision loss.
// Money is bounded far below 2^53 by column CHECKs, so convert to number but refuse to
// silently round if that bound is ever broken.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`BIGINT value ${value} exceeds the safe integer range`);
  }
  return n;
});
// SUM(bigint) yields NUMERIC; we only ever sum integer paise, so the same rule applies.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`NUMERIC value ${value} is not a safe integer`);
  }
  return n;
});

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(options: { connectionString: string; max: number }): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: options.connectionString, max: options.max }),
    }),
  });
}
