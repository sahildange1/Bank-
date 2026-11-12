/**
 * Money is carried as integer minor units in a string (the API serializes
 * BigInt that way) and formatted with BigInt arithmetic — never a float.
 */
const EXPONENT: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, INR: 2, JPY: 0 };
const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' };

export function formatMinor(minor: string, currency: string): string {
  const exp = EXPONENT[currency] ?? 2;
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(exp);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = exp > 0 ? '.' + (abs % base).toString().padStart(exp, '0') : '';
  return `${negative ? '-' : ''}${SYMBOL[currency] ?? currency + ' '}${whole}${frac}`;
}

export function sumMinor(values: string[]): string {
  return values.reduce((a, v) => a + BigInt(v), 0n).toString();
}
