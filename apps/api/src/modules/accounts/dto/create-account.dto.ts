import { IsString, Length, Matches } from 'class-validator';

export class CreateAccountDto {
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter uppercase ISO code, e.g. USD' })
  currency!: string;
}
