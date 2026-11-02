import { Injectable } from '@nestjs/common';

export interface PaymentProviderRequest {
  paymentId: string;
  amountMinorUnits: bigint;
  currency: string;
  beneficiaryAccountNumber: string;
}

export interface PaymentProviderResult {
  success: boolean;
  providerReference: string;
  failureReason?: string;
}

/**
 * The "mock/sandbox payment provider" the brief calls for explicitly — this
 * is the only thing in the codebase that stands in for an external payment
 * rail, and it NEVER moves real money (brief's own hard boundary, repeated
 * in the architecture doc's compliance section). It is injectable
 * (`PaymentExecutionService` depends on this class, not a concrete HTTP
 * client) specifically so a real integration — or a test double that
 * forces a specific outcome — can be swapped in without touching
 * PaymentExecutionService at all.
 *
 * Deliberately always succeeds in this phase: a sandbox platform has no
 * real external failure modes to simulate, and the honest alternative
 * (fabricating a plausible-looking failure-rate curve) would just be
 * inventing provider behavior with no better basis than "it doesn't
 * matter either way, pick a number." A real integration, or a richer
 * configurable-outcome test double, is a project-specific follow-on — not
 * guessed at here. `PaymentExecutionService`'s own tests exercise the
 * failure branch by injecting a mock implementation of this interface,
 * not by relying on this class to ever actually return one.
 */
@Injectable()
export class MockPaymentProviderService {
  async submit(request: PaymentProviderRequest): Promise<PaymentProviderResult> {
    return {
      success: true,
      providerReference: `MOCK-${request.paymentId}-${Date.now()}`,
    };
  }
}
