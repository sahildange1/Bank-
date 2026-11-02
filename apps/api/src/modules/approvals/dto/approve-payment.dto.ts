import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApprovePaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
