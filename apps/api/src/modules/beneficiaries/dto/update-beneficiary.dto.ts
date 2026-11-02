import { IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class UpdateBeneficiaryDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(140)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(34)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @Length(1, 34)
  bankIdentifier?: string;
}
