import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectBeneficiaryDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
