import { IsString, Length, Matches } from 'class-validator';

export class EnrollMfaConfirmDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  code!: string;
}
