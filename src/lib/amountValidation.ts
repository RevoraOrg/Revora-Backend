/**
 * Checks a positive decimal string using a bounded fractional precision.
 * Numeric conversion is avoided so validation does not lose decimal precision.
 */
export function isPositiveDecimalAmount(value: string): boolean {
  return /^\d+(\.\d{1,10})?$/.test(value) && /[1-9]/.test(value);
}
