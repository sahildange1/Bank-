import { IsString, IsNumberString, Length, Matches, MaxLength } from 'class-validator';

export class CreateTransferDto {
  @IsString()
  sourceAccountId!: string;

  @IsString()
  destinationAccountId!: string;

  // Accepted as a numeric string (minor units) rather than `number` to
  // avoid any temptation to let JS floating point touch a money amount
  // anywhere, including in request parsing (architecture §9).
  @IsNumberString()
  amountMinorUnits!: string;

  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @MaxLength(200)
  description!: string;

  @IsString()
  idempotencyKey!: string;
}
