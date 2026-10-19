/**
 * Every failure a client can act on has a stable machine-readable `code`. The HTTP layer
 * renders these as RFC 9457 problem+json; `extras` become additional members so clients get
 * structured detail (which lines are short, which prices moved, which order already exists).
 */
export const ERROR_TITLES = {
  VALIDATION_FAILED: 'Request validation failed',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required',
  PAYMENT_DECLINED: 'Payment was declined',
  ROUTE_NOT_FOUND: 'Route not found',
  CART_NOT_FOUND: 'Cart not found',
  CART_ITEM_NOT_FOUND: 'Cart item not found',
  PRODUCT_NOT_FOUND: 'Product not found',
  ORDER_NOT_FOUND: 'Order not found',
  CART_NOT_OPEN: 'Cart can no longer be modified',
  CART_ALREADY_CHECKED_OUT: 'Cart has already been checked out',
  INSUFFICIENT_INVENTORY: 'Insufficient inventory',
  PRICE_CHANGED: 'Prices changed since they were acknowledged',
  COUPON_ALREADY_REDEEMED: 'Coupon has already been redeemed',
  NO_ELIGIBLE_MILESTONE: 'No unrewarded order milestone is eligible',
  STOCK_WOULD_BE_NEGATIVE: 'Stock adjustment would make stock negative',
  CART_EMPTY: 'Cart is empty',
  COUPON_NOT_FOUND: 'Coupon not found',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency-Key was already used for a different request',
  QUANTITY_LIMIT_EXCEEDED: 'Quantity limit exceeded',
  LOCK_TIMEOUT: 'Resource is busy, retry shortly',
  INTERNAL: 'Internal server error',
} as const;

export type ErrorCode = keyof typeof ERROR_TITLES;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    detail: string,
    readonly extras: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = 'AppError';
  }
}

export interface Shortage {
  productId: string;
  requested: number;
  available: number;
}

export interface PriceChange {
  productId: string;
  acknowledgedUnitPricePaise: number;
  currentUnitPricePaise: number;
}

export const Errors = {
  cartNotFound: (cartId: string) =>
    new AppError('CART_NOT_FOUND', 404, `Cart ${cartId} does not exist`, { cartId }),
  cartItemNotFound: (cartId: string, productId: string) =>
    new AppError('CART_ITEM_NOT_FOUND', 404, `Product ${productId} is not in cart ${cartId}`, {
      cartId,
      productId,
    }),
  productNotFound: (productId: string) =>
    new AppError('PRODUCT_NOT_FOUND', 404, `Product ${productId} does not exist`, { productId }),
  /** Unknown product referenced in a request body: the request, not the URL, is wrong. */
  unknownProduct: (productId: string) =>
    new AppError('PRODUCT_NOT_FOUND', 422, `Product ${productId} does not exist`, { productId }),
  orderNotFound: (orderId: string) =>
    new AppError('ORDER_NOT_FOUND', 404, `Order ${orderId} does not exist`, { orderId }),
  cartNotOpen: (cartId: string, orderId: string | null) =>
    new AppError('CART_NOT_OPEN', 409, `Cart ${cartId} has been checked out and is read-only`, {
      cartId,
      orderId,
    }),
  cartAlreadyCheckedOut: (cartId: string, orderId: string | null) =>
    new AppError(
      'CART_ALREADY_CHECKED_OUT',
      409,
      `Cart ${cartId} was already checked out as order ${orderId}`,
      { cartId, orderId },
    ),
  cartEmpty: (cartId: string) =>
    new AppError('CART_EMPTY', 422, `Cart ${cartId} has no items`, { cartId }),
  insufficientInventory: (shortages: Shortage[]) =>
    new AppError(
      'INSUFFICIENT_INVENTORY',
      409,
      `Not enough stock for: ${shortages.map((s) => s.productId).join(', ')}`,
      { shortages },
    ),
  priceChanged: (changes: PriceChange[]) =>
    new AppError(
      'PRICE_CHANGED',
      409,
      'Unit prices changed after they were added to the cart. Review the cart, acknowledge the current prices, then retry checkout.',
      { changes },
    ),
  quantityLimitExceeded: (productId: string, requested: number, max: number) =>
    new AppError(
      'QUANTITY_LIMIT_EXCEEDED',
      422,
      `Quantity ${requested} for ${productId} exceeds the per-line maximum of ${max}`,
      { productId, requested, max },
    ),
  couponNotFound: (code: string) =>
    new AppError('COUPON_NOT_FOUND', 422, `Coupon ${code} does not exist`, { couponCode: code }),
  couponAlreadyRedeemed: (code: string) =>
    new AppError('COUPON_ALREADY_REDEEMED', 409, `Coupon ${code} has already been redeemed`, {
      couponCode: code,
    }),
  noEligibleMilestone: (placedOrders: number, nextMilestoneAt: number) =>
    new AppError(
      'NO_ELIGIBLE_MILESTONE',
      409,
      `Next coupon unlocks at ${nextMilestoneAt} placed orders; ${placedOrders} placed so far`,
      { placedOrders, nextMilestoneAt, ordersRemaining: nextMilestoneAt - placedOrders },
    ),
  stockWouldBeNegative: (productId: string, stock: number, adjustment: number) =>
    new AppError(
      'STOCK_WOULD_BE_NEGATIVE',
      409,
      `Adjusting ${productId} stock by ${adjustment} would go below zero`,
      { productId, stock, adjustment },
    ),
  idempotencyKeyRequired: () =>
    new AppError(
      'IDEMPOTENCY_KEY_REQUIRED',
      400,
      'Send an Idempotency-Key header (1-255 chars) so retries cannot create duplicate orders',
    ),
  idempotencyKeyReused: (key: string) =>
    new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      422,
      `Idempotency-Key ${key} was already used with a different cart or request body`,
      { idempotencyKey: key },
    ),
  paymentDeclined: (reason: string) =>
    new AppError('PAYMENT_DECLINED', 402, `Payment declined: ${reason}`, { reason }),
  lockTimeout: () =>
    new AppError(
      'LOCK_TIMEOUT',
      503,
      'Another request is holding the same resources; retry with the same Idempotency-Key',
    ),
};
