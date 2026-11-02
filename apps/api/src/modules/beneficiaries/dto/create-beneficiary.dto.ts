import { IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class CreateBeneficiaryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(140)
  name!: string;

  @IsString()
  @MinLength(4)
  @MaxLength(34) // IBAN max length; sandbox accepts any scheme up to this
  accountNumber!: string;

  @IsOptional()
  @IsString()
  @Length(1, 34)
  bankIdentifier?: string;
}
