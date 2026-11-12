import { IsString, Length, Matches, MaxLength } from 'class-validator';

export class VerifyMfaDto {
  @IsString()
  @MaxLength(1024)
  challengeId!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  code!: string;
}
