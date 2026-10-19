export interface ChargeRequest {
  orderId: string;
  amountPaise: number;
  currency: string;
  /** Forwarded so a real provider can deduplicate retried charges on its side too. */
  idempotencyKey: string;
}

export interface ChargeResult {
  reference: string;
}

export class PaymentDeclinedError extends Error {
  constructor(readonly reason: string) {
    super(`Payment declined: ${reason}`);
    this.name = 'PaymentDeclinedError';
  }
}

/**
 * Seam for payment. Checkout calls it inside its database transaction, after inventory and
 * coupon are claimed and before anything commits, so a decline rolls everything back.
 * That is only acceptable because the fake is in-process and instant; DECISIONS.md describes
 * the reservation/saga shape a real, slow, remote provider would need.
 */
export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

/** Always approves unless a test injects a decline rule. */
export class FakePaymentGateway implements PaymentGateway {
  constructor(
    private readonly options: { decline?: (request: ChargeRequest) => string | null } = {},
  ) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const reason = this.options.decline?.(request);
    if (reason) throw new PaymentDeclinedError(reason);
    return { reference: `fakepay_${request.orderId}` };
  }
}
