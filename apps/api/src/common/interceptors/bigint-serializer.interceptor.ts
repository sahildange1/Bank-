import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Money is stored and computed as BigInt minor units (never floats), but
 * JSON.stringify throws "Do not know how to serialize a BigInt", so any
 * endpoint returning a Prisma row with a money column (accounts, payments,
 * ledger entries) would have failed with a 500. This converts every bigint
 * in a response body to a decimal STRING — lossless, unlike a JSON number
 * past 2^53 — which is also how requests already send amounts
 * (`amountMinorUnits: "5000"`).
 */
export function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInts);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    // Only plain objects: leave Date, Buffer, streams etc. untouched.
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeBigInts(v)]));
    }
  }
  return value;
}

@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(serializeBigInts));
  }
}
