import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** approve / reactivate: a reason is optional context. */
export class OptionalReasonDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** suspend / close: a written reason is mandatory — it is the audit record of why. */
export class RequiredReasonDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}
