import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError, ERROR_TITLES, Errors, type ErrorCode } from '../domain/errors.js';

/** RFC 9457 problem details, plus a stable `code` clients can switch on. */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
  instance?: string;
  [extra: string]: unknown;
}

const kebab = (code: string) => code.toLowerCase().replaceAll('_', '-');

function fromAppError(error: AppError, instance?: string): ProblemBody {
  return {
    ...error.extras,
    type: `/problems/${kebab(error.code)}`,
    title: ERROR_TITLES[error.code],
    status: error.status,
    detail: error.message,
    code: error.code,
    ...(instance ? { instance } : {}),
  };
}

// Backstops: the services' locks and compare-and-set updates make these unreachable, but if a
// code path ever skips them the constraint still refuses the write and the client gets the
// domain error rather than a 500. (Verified by removing the coupon CAS: the race test still
// passes because orders_coupon_code_key rejects the second redemption.)
const UNIQUE_VIOLATIONS: Record<string, () => AppError> = {
  orders_cart_id_key: () =>
    new AppError('CART_ALREADY_CHECKED_OUT', 409, 'Cart has already been checked out'),
  orders_coupon_code_key: () =>
    new AppError('COUPON_ALREADY_REDEEMED', 409, 'Coupon has already been redeemed'),
  coupons_redeemed_order_id_key: () =>
    new AppError('COUPON_ALREADY_REDEEMED', 409, 'Coupon has already been redeemed'),
};

const RETRYABLE_PG_CODES = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);

interface ErrorLike {
  code?: unknown;
  constraint?: unknown;
  statusCode?: unknown;
  message?: unknown;
}

export function toProblem(error: unknown, instance?: string): ProblemBody {
  if (error instanceof AppError) {
    return fromAppError(error, instance);
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const location = (error as { validationContext?: string }).validationContext ?? 'request';
    return {
      type: '/problems/validation-failed',
      title: ERROR_TITLES.VALIDATION_FAILED,
      status: 400,
      detail: `Invalid ${location}`,
      code: 'VALIDATION_FAILED',
      errors: error.validation.map((issue) => ({
        location,
        path: issue.instancePath,
        message: issue.message,
      })),
      ...(instance ? { instance } : {}),
    };
  }

  const e = (typeof error === 'object' && error !== null ? error : {}) as ErrorLike;

  if (typeof e.code === 'string' && RETRYABLE_PG_CODES.has(e.code)) {
    return fromAppError(Errors.lockTimeout(), instance);
  }
  if (e.code === '23505' && typeof e.constraint === 'string' && UNIQUE_VIOLATIONS[e.constraint]) {
    return fromAppError(UNIQUE_VIOLATIONS[e.constraint]!(), instance);
  }

  // Framework-level client errors: malformed JSON, unsupported media type, body too large...
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return {
      type: '/problems/validation-failed',
      title: ERROR_TITLES.VALIDATION_FAILED,
      status: e.statusCode,
      detail: typeof e.message === 'string' ? e.message : 'Invalid request',
      code: 'VALIDATION_FAILED',
      ...(instance ? { instance } : {}),
    };
  }

  return {
    type: '/problems/internal',
    title: ERROR_TITLES.INTERNAL,
    status: 500,
    detail: 'An unexpected error occurred',
    code: 'INTERNAL',
    ...(instance ? { instance } : {}),
  };
}
