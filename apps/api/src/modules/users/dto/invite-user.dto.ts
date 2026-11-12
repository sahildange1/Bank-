import { ArrayMinSize, IsArray, IsEmail, IsString, ArrayMaxSize, MaxLength } from 'class-validator';

export class InviteUserDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'at least one role must be assigned' })
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  roleNames!: string[];
}
