import { ConflictException } from '@nestjs/common';
import { PaymentStateMachine, PaymentStatus } from './payment-state-machine';

describe('PaymentStateMachine', () => {
  const machine = new PaymentStateMachine();

  const legalTransitions: Array<[PaymentStatus, PaymentStatus]> = [
    ['DRAFT', 'PENDING_APPROVAL'],
    ['DRAFT', 'CANCELLED'],
    ['PENDING_APPROVAL', 'APPROVED'],
    ['PENDING_APPROVAL', 'REJECTED'],
    ['PENDING_APPROVAL', 'CANCELLED'],
    ['APPROVED', 'PROCESSING'],
    ['PROCESSING', 'COMPLETED'],
    ['PROCESSING', 'FAILED'],
  ];

  it.each(legalTransitions)('allows %s -> %s', (from, to) => {
    expect(() => machine.assertValidTransition(from, to)).not.toThrow();
  });

  const illegalTransitions: Array<[PaymentStatus, PaymentStatus]> = [
    ['DRAFT', 'APPROVED'], // skipping the approval step entirely
    ['DRAFT', 'PROCESSING'],
    ['DRAFT', 'COMPLETED'],
    ['PENDING_APPROVAL', 'PROCESSING'], // skipping APPROVED
    ['PENDING_APPROVAL', 'COMPLETED'],
    ['APPROVED', 'COMPLETED'], // skipping PROCESSING
    ['APPROVED', 'PENDING_APPROVAL'], // no going backwards
    ['REJECTED', 'PENDING_APPROVAL'], // terminal states never resume
    ['CANCELLED', 'DRAFT'],
    ['COMPLETED', 'FAILED'],
    ['FAILED', 'PROCESSING'],
    ['COMPLETED', 'COMPLETED'], // no-op "transitions" are still rejected
  ];

  it.each(illegalTransitions)('rejects %s -> %s', (from, to) => {
    expect(() => machine.assertValidTransition(from, to)).toThrow(ConflictException);
  });

  describe('isTerminal', () => {
    it.each<PaymentStatus>(['REJECTED', 'CANCELLED', 'COMPLETED', 'FAILED'])('%s is terminal', (status) => {
      expect(machine.isTerminal(status)).toBe(true);
    });

    it.each<PaymentStatus>(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING'])(
      '%s is not terminal',
      (status) => {
        expect(machine.isTerminal(status)).toBe(false);
      },
    );
  });
});
