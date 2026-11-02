import { PaymentExecutionService } from './payment-execution.service';
import { PaymentStateMachine } from './payment-state-machine';

/**
 * Same mocked-Prisma approach as the rest of this repo's service unit
 * tests, with the real (non-mocked) PaymentStateMachine so
 * APPROVED -> PROCESSING -> COMPLETED/FAILED is exercised for real, not
 * just assumed legal. The provider is a hand-written stub implementing
 * MockPaymentProviderService's shape, swapped in per test to force each
 * branch (success / declined / throws) — exactly the seam
 * MockPaymentProviderService's own doc comment describes.
 */
describe('PaymentExecutionService (unit, mocked Prisma)', () => {
  const ORG_ID = 'org-1';
  const ACTOR_ID = 'user-1';

  const APPROVED_PAYMENT = {
    id: 'pay-1',
    status: 'APPROVED',
    sourceAccountId: 'acct-source',
    beneficiaryId: 'ben-1',
    amountMinorUnits: 25_000n,
    currency: 'USD',
  };

  function makeService(provider: { submit: jest.Mock }) {
    const scopedClient = {
      payment: { findUnique: jest.fn() },
      beneficiary: { findUnique: jest.fn() },
    };
    const tx = {
      payment: { update: jest.fn() },
      paymentStateTransition: { create: jest.fn() },
    };
    const rawPrisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      payment: { findMany: jest.fn() },
    };
    const tenantPrisma = { forOrg: jest.fn().mockReturnValue(scopedClient) };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const ledgerService = {
      getOrCreateSettlementAccount: jest.fn(),
      postDoubleEntry: jest.fn(),
    };
    const stateMachine = new PaymentStateMachine();

    const service = new PaymentExecutionService(
      rawPrisma as any,
      tenantPrisma as any,
      auditService as any,
      ledgerService as any,
      stateMachine,
      provider as any,
    );
    return { service, scopedClient, rawPrisma, tx, auditService, ledgerService };
  }

  it('rejects executing a payment that is not APPROVED', async () => {
    const { service, scopedClient } = makeService({ submit: jest.fn() });
    scopedClient.payment.findUnique.mockResolvedValue({ ...APPROVED_PAYMENT, status: 'PENDING_APPROVAL' });

    await expect(service.executePayment(ORG_ID, ACTOR_ID, 'pay-1')).rejects.toThrow();
  });

  it('on provider success: moves APPROVED -> PROCESSING -> COMPLETED and posts source DEBIT / settlement CREDIT through the ledger', async () => {
    const submit = jest.fn().mockResolvedValue({ success: true, providerReference: 'MOCK-REF-1' });
    const { service, scopedClient, tx, ledgerService, auditService } = makeService({ submit });
    scopedClient.payment.findUnique
      .mockResolvedValueOnce({ ...APPROVED_PAYMENT }) // the read at the top of executePayment()
      .mockResolvedValue({ ...APPROVED_PAYMENT, status: 'COMPLETED' }); // the final getPayment() read
    scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', accountNumber: '1234567890' });
    ledgerService.getOrCreateSettlementAccount.mockResolvedValue({ id: 'settlement-1' });
    ledgerService.postDoubleEntry.mockResolvedValue({ groupId: 'group-1', alreadyPosted: false });

    const result = await service.executePayment(ORG_ID, ACTOR_ID, 'pay-1');

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay-1', amountMinorUnits: 25_000n, currency: 'USD', beneficiaryAccountNumber: '1234567890' }),
    );
    expect(ledgerService.postDoubleEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'pay-1',
        entries: [
          { accountId: 'acct-source', direction: 'DEBIT', amountMinorUnits: 25_000n, currency: 'USD' },
          { accountId: 'settlement-1', direction: 'CREDIT', amountMinorUnits: 25_000n, currency: 'USD' },
        ],
      }),
    );
    // Two transitions: APPROVED -> PROCESSING, then PROCESSING -> COMPLETED.
    expect(tx.payment.update).toHaveBeenCalledTimes(2);
    expect(tx.payment.update).toHaveBeenNthCalledWith(1, { where: { id: 'pay-1' }, data: { status: 'PROCESSING' } });
    expect(tx.payment.update).toHaveBeenNthCalledWith(2, { where: { id: 'pay-1' }, data: { status: 'COMPLETED' } });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.processing_started' }), tx);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.completed' }), tx);
    expect(result?.status).toEqual('COMPLETED');
  });

  it('on provider decline: moves to PROCESSING then FAILED, and never touches the ledger', async () => {
    const submit = jest.fn().mockResolvedValue({ success: false, providerReference: 'MOCK-REF-2', failureReason: 'insufficient counterparty details' });
    const { service, scopedClient, tx, ledgerService, auditService } = makeService({ submit });
    scopedClient.payment.findUnique.mockResolvedValue({ ...APPROVED_PAYMENT });
    scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', accountNumber: '1234567890' });

    await service.executePayment(ORG_ID, ACTOR_ID, 'pay-1');

    expect(ledgerService.postDoubleEntry).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenNthCalledWith(2, { where: { id: 'pay-1' }, data: { status: 'FAILED' } });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.failed', metadata: { reason: 'insufficient counterparty details' } }),
      tx,
    );
  });

  it('on provider throw: still resolves to FAILED rather than leaving the payment stuck in PROCESSING', async () => {
    const submit = jest.fn().mockRejectedValue(new Error('connection reset'));
    const { service, scopedClient, tx, ledgerService } = makeService({ submit });
    scopedClient.payment.findUnique.mockResolvedValue({ ...APPROVED_PAYMENT });
    scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', accountNumber: '1234567890' });

    await service.executePayment(ORG_ID, ACTOR_ID, 'pay-1');

    expect(ledgerService.postDoubleEntry).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenNthCalledWith(2, { where: { id: 'pay-1' }, data: { status: 'FAILED' } });
  });

  it('on ledger posting failure after provider success: resolves to FAILED, not a COMPLETED payment with no ledger trail', async () => {
    const submit = jest.fn().mockResolvedValue({ success: true, providerReference: 'MOCK-REF-3' });
    const { service, scopedClient, tx, ledgerService } = makeService({ submit });
    scopedClient.payment.findUnique.mockResolvedValue({ ...APPROVED_PAYMENT });
    scopedClient.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', accountNumber: '1234567890' });
    ledgerService.getOrCreateSettlementAccount.mockResolvedValue({ id: 'settlement-1' });
    ledgerService.postDoubleEntry.mockRejectedValue(new Error('insufficient funds'));

    await service.executePayment(ORG_ID, ACTOR_ID, 'pay-1');

    expect(tx.payment.update).toHaveBeenNthCalledWith(2, { where: { id: 'pay-1' }, data: { status: 'FAILED' } });
  });

  it('fails cleanly, without calling the provider, when the beneficiary no longer exists', async () => {
    const submit = jest.fn();
    const { service, scopedClient, tx } = makeService({ submit });
    scopedClient.payment.findUnique.mockResolvedValue({ ...APPROVED_PAYMENT });
    scopedClient.beneficiary.findUnique.mockResolvedValue(null);

    await service.executePayment(ORG_ID, ACTOR_ID, 'pay-1');

    expect(submit).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenNthCalledWith(2, { where: { id: 'pay-1' }, data: { status: 'FAILED' } });
  });
});
