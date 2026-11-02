import { IsString, Length, Matches } from 'class-validator';

export class VerifyMfaDto {
  @IsString()
  challengeId!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  code!: string;
}
