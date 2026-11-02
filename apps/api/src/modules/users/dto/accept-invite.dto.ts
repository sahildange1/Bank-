import { IsString, MinLength } from 'class-validator';

export class AcceptInviteDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  password!: string;
}
