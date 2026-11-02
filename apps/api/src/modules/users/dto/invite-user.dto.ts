import { ArrayMinSize, IsArray, IsEmail, IsString } from 'class-validator';

export class InviteUserDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'at least one role must be assigned' })
  @IsString({ each: true })
  roleNames!: string[];
}
