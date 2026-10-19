import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/checkout'),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
  // n: every n-th placed order makes one coupon available.
  REWARD_EVERY_N_ORDERS: z.coerce.number().int().min(1).default(5),
  // x: whole percent off. 100 is allowed (free order) but can never push a total below zero.
  REWARD_DISCOUNT_PERCENT: z.coerce.number().int().min(1).max(100).default(10),
  SEED_ON_START: booleanString.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface RewardConfig {
  everyNOrders: number;
  /** Discount in basis points (1% = 100 bps) so percentages never touch floating point. */
  discountBps: number;
}

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  dbPoolMax: number;
  rewards: RewardConfig;
  seedOnStart: boolean;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Fail fast: a misconfigured reward rule would silently mint wrong coupons.
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    rewards: {
      everyNOrders: e.REWARD_EVERY_N_ORDERS,
      discountBps: e.REWARD_DISCOUNT_PERCENT * 100,
    },
    seedOnStart: e.SEED_ON_START,
    logLevel: e.LOG_LEVEL,
  };
}
