import { IsEmail, IsString, MinLength } from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @MinLength(2)
  legalName!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  adminPassword!: string;
}
