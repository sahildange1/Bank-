import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * The only place password hashing happens. No custom crypto — argon2id via
 * the maintained `argon2` package (a binding to the reference Argon2 C
 * implementation), with parameters aligned to current OWASP guidance.
 */
@Injectable()
export class PasswordService {
  private readonly options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19456, // ~19 MB, OWASP minimum recommendation
    timeCost: 2,
    parallelism: 1,
  };

  async hash(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, this.options);
  }

  async verify(hash: string, plainPassword: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainPassword);
    } catch {
      // Malformed/foreign hash format — treat as non-match, never throw
      // out of an auth check.
      return false;
    }
  }
}
