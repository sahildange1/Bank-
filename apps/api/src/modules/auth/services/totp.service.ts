import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as crypto from 'crypto';

/**
 * TOTP (RFC 6238) via `otplib`, a maintained library — not custom crypto.
 * Factor secrets are encrypted at rest with AES-256-GCM using a key from
 * `MFA_ENCRYPTION_KEY` (expected to come from a real secrets manager in
 * production, not the .env file — see architecture §5/§13).
 */
@Injectable()
export class TotpService {
  private getKey(): Buffer {
    const key = process.env.MFA_ENCRYPTION_KEY;
    if (!key || Buffer.from(key, 'utf8').length < 32) {
      throw new Error('MFA_ENCRYPTION_KEY must be set and at least 32 bytes');
    }
    return crypto.createHash('sha256').update(key).digest(); // normalize to 32 bytes
  }

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  keyUri(secret: string, accountEmail: string, issuer = 'Corporate Banking Platform'): string {
    return authenticator.keyuri(accountEmail, issuer, secret);
  }

  verify(secret: string, token: string): boolean {
    try {
      return authenticator.verify({ token, secret });
    } catch {
      return false;
    }
  }

  encryptSecret(secret: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
  }

  decryptSecret(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('Malformed encrypted MFA secret');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
  }
}
