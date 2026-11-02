import { IsISO8601, IsNumberString, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  sourceAccountId!: string;

  @IsString()
  beneficiaryId!: string;

  // Numeric string, not `number` — same reasoning as CreateTransferDto
  // (Phase 6): money never touches JS floating point, including at the
  // request-parsing boundary (architecture §9).
  @IsNumberString()
  amountMinorUnits!: string;

  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  reference?: string;

  // Future-dated one-off scheduling: accepted and stored, but no
  // background worker executes it yet (BullMQ/Redis infra flagged as
  // deferred since Phase 1 — see the Phase 8 write-up). A payment with a
  // future scheduledFor can be created and submitted/approved like any
  // other; it simply won't auto-advance past APPROVED on its own yet.
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;

  @IsString()
  idempotencyKey!: string;
}
