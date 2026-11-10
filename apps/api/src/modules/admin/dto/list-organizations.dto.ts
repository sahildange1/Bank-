import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListOrganizationsDto {
  @IsOptional() @IsIn(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED']) status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsString() @MaxLength(100) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
