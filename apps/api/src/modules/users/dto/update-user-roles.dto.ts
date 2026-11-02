import { ArrayMinSize, IsArray, IsString } from 'class-validator';

export class UpdateUserRolesDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'at least one role must be assigned' })
  @IsString({ each: true })
  roleNames!: string[];
}
