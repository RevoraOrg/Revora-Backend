import { AppError, ErrorCode, Errors } from './errors';

/**
 * @title Decimal Utility for Soroban i128 Alignment
 * @notice Provides safe and precise handling of decimal strings,
 *         including conversion to/from scaled BigInt for Soroban i128 compatibility.
 * @dev This utility uses BigInt internally to avoid floating-point inaccuracies.
 *      It supports up to 18 decimal places for input, and allows conversion to
 *      a specified fixed scale (e.g., 7 for Stellar native assets).
 *
 * Security Assumptions:
 * - Input decimal strings are validated against a strict regex to prevent malformed data.
 * - Precision is maintained using BigInt, preventing floating-point vulnerabilities.
 * - Range checks are performed before converting to Soroban i128 to prevent overflow/underflow.
 * - All errors are structured AppErrors, preventing sensitive internal details from being exposed.
 * - Regex patterns are designed to prevent ReDoS (catastrophic backtracking).
 */

// Matches integer or decimal strings with optional leading sign and up to 18 fractional digits.
// Requires at least one leading digit before the decimal point (rejects `.5`).
// This regex is designed to prevent ReDoS by using bounded quantifiers.
const DECIMAL_REGEX = /^-?\d+(\.\d{1,18})?$/;

// Soroban i128 max and min values.
// i128 is a signed 128-bit integer.
// Max: 2^127 - 1
// Min: -2^127
const I128_MAX = 170141183460469231731687303715884105727n; // 2^127 - 1
const I128_MIN = -170141183460469231731687303715884105728n; // -2^127

/**
 * Represents a decimal number with arbitrary precision, primarily for financial calculations
 * and interoperability with Soroban's i128 type.
 */
export class Decimal {
  private readonly _value: bigint; // Scaled integer value
  private readonly _scale: number; // Number of decimal places

  /**
   * Creates a Decimal instance from a decimal string.
   * @param decimalString The decimal number as a string (e.g., "123.45", "0.001").
   *                      Must be positive and have up to 18 decimal places.
   * @throws {AppError} if the string is not a valid positive decimal or exceeds 18 decimal places.
   */
  constructor(decimalString: string) {
    if (!DECIMAL_REGEX.test(decimalString)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        `Invalid decimal string format: "${decimalString}". Must be a numeric string with up to 18 decimal places.`,
        { field: 'amount', value: decimalString }
      );
    }

    const parts = decimalString.split('.');
    const integerPart = parts[0];
    const fractionalPart = parts[1] || '';

    this._scale = fractionalPart.length;
    this._value = BigInt(integerPart + fractionalPart);
  }

  /**
   * Returns the decimal value as a string. Correctly handles negative values
   * (the scaled `_value` can be negative after a subtraction).
   */
  toString(): string {
    const isNegative = (this._value as BigInt) < (0 as BigInt);
    const absValue = isNegative ? -this._value : this._value;
    const valueStr = absValue.toString();

    if (this._scale === 0) {
      return isNegative ? `-${valueStr}` : valueStr;
    }

    const integerPartLength = valueStr.length - this._scale;

    if (integerPartLength <= 0) {
      // e.g., 0.001 for value=1, scale=3 (or -0.0005 for value=-5, scale=4)
      return `${isNegative ? '-' : ''}0.${'0'.repeat(-integerPartLength)}${valueStr}`;
    }

    const integerPart = valueStr.substring(0, integerPartLength);
    const fractionalPart = valueStr.substring(integerPartLength).padEnd(this._scale, '0');

    return `${isNegative ? '-' : ''}${integerPart}.${fractionalPart}`;
  }

  /**
   * Converts the Decimal to a scaled BigInt suitable for Soroban i128.
   * This involves adjusting the scale and potentially rounding.
   * @param targetScale The desired number of decimal places for the Soroban i128 representation.
   * @param roundingMode The rounding mode to use if precision is lost (e.g., 'round', 'floor', 'ceil', 'truncate').
   *                     Defaults to 'round' (round half up).
   * @returns The scaled BigInt.
   * @throws {AppError} if the value exceeds Soroban i128 limits after scaling.
   */
  toSorobanI128(targetScale: number, roundingMode: 'round' | 'floor' | 'ceil' | 'truncate' = 'round'): bigint {
    if (targetScale < 0 || targetScale > 18) { // Common max scale for Stellar is 7, but 18 is max for input.
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        500,
        `Invalid target scale for Soroban i128 conversion: ${targetScale}. Must be between 0 and 18.`
      );
    }

    let scaledValue: bigint;
    if (this._scale === targetScale) {
      scaledValue = this._value;
    } else if (this._scale < targetScale) {
      // Increase precision (add zeros)
      scaledValue = this._value * (10n ** BigInt(targetScale - this._scale));
    } else {
      // Decrease precision (remove digits, potentially round)
      const diffScale = BigInt(this._scale - targetScale);
      const divisor = 10n ** diffScale;
      const remainder = this._value % divisor;

      scaledValue = this._value / divisor;

      if (remainder !== 0n) {
        switch (roundingMode) {
          case 'round':
            // Round half up (e.g., 0.5 rounds to 1)
            if (remainder * 2n >= divisor) {
              scaledValue += 1n;
            }
            break;
          case 'floor':
            // Truncate towards negative infinity
            break;
          case 'ceil':
            // Truncate towards positive infinity
            scaledValue += 1n;
            break;
          case 'truncate':
            // Truncate towards zero (same as floor for positive, ceil for negative)
            break;
        }
      }
    }

    if (scaledValue > I128_MAX || scaledValue < I128_MIN) {
      throw Errors.internal('DECIMAL_OVERFLOW', {
        message: `Decimal value ${this.toString()} exceeds Soroban i128 limits after scaling to ${targetScale} decimals.`,
        value: this.toString(),
        scaledValue: scaledValue.toString(),
        targetScale,
      });
    }

    return scaledValue;
  }

  /**
   * Creates a Decimal instance from a scaled BigInt and its scale.
   * @param scaledValue The BigInt representing the scaled value.
   * @param scale The number of decimal places.
   * @returns A Decimal instance.
   * @throws {AppError} if the scale is invalid.
   */
  static fromScaledBigInt(scaledValue: bigint, scale: number): Decimal {
    if (scale < 0 || scale > 18) {
      throw Errors.internal(`Invalid scale for Decimal.fromScaledBigInt: ${scale}. Must be between 0 and 18.`);
    }

    const divisor = 10n ** BigInt(scale);

    // Handle negative values explicitly to avoid producing strings like "123.-05".
    const isNegative = (scaledValue as BigInt) < (0 as BigInt);
    const absValue = isNegative ? -scaledValue : scaledValue;
    const integerPart = absValue / divisor;
    const fractionalPart = absValue % divisor;

    let decimalString = integerPart.toString();
    if (scale > 0) {
      const fractionalStr = fractionalPart.toString().padStart(scale, '0');
      decimalString += `.${fractionalStr}`;
    }

    if (isNegative) decimalString = `-${decimalString}`;

    // Re-parse to ensure consistency and validation
    return new Decimal(decimalString);
  }

  /**
   * Performs addition of two Decimal numbers.
   * @param other The other Decimal number to add.
   * @returns A new Decimal instance representing the sum.
   */
  add(other: Decimal): Decimal {
    const commonScale = Math.max(this._scale, other._scale);
    const thisScaled = this._value * (10n ** BigInt(commonScale - this._scale));
    const otherScaled = other._value * (10n ** BigInt(commonScale - other._scale));
    const sum = thisScaled + otherScaled;
    return Decimal.fromScaledBigInt(sum, commonScale);
  }

  /**
   * Performs subtraction of two Decimal numbers.
   * @param other The other Decimal number to subtract.
   * @returns A new Decimal instance representing the difference.
   */
  subtract(other: Decimal): Decimal {
    const commonScale = Math.max(this._scale, other._scale);
    const thisScaled = this._value * (10n ** BigInt(commonScale - this._scale));
    const otherScaled = other._value * (10n ** BigInt(commonScale - other._scale));
    const difference = thisScaled - otherScaled;
    return Decimal.fromScaledBigInt(difference, commonScale);
  }

  /**
   * Performs multiplication of two Decimal numbers.
   * Note: This can increase the scale up to 36 (18 + 18).
   * @param other The other Decimal number to multiply.
   * @returns A new Decimal instance representing the product.
   */
  multiply(other: Decimal): Decimal {
    const productValue = this._value * other._value;
    const productScale = this._scale + other._scale;
    if (productScale > 18) { // Limit scale to 18 for practical use, might need rounding
        // For simplicity, we'll truncate extra precision for now.
        // A more robust solution would involve explicit rounding or a dedicated BigNumber library.
        const excessScale = productScale - 18;
        const divisor = 10n ** BigInt(excessScale);
        return Decimal.fromScaledBigInt(productValue / divisor, 18);
    }
    return Decimal.fromScaledBigInt(productValue, productScale);
  }

  /**
   * Performs division of two Decimal numbers.
   * Note: Division can result in infinite decimal places. This implementation
   * will truncate to a fixed precision (e.g., 18 decimal places).
   * @param other The other Decimal number to divide by.
   * @returns A new Decimal instance representing the quotient.
   * @throws {AppError} if division by zero occurs.
   */
  divide(other: Decimal): Decimal {
    if (other._value === 0n) {
      throw new AppError(ErrorCode.BAD_REQUEST, 400, 'Division by zero');
    }

    // To maintain precision, scale up the numerator before division.
    // We'll aim for 18 decimal places in the result.
    const targetScale = 18;
    const thisScaled = this._value * (10n ** BigInt(targetScale + other._scale - this._scale));
    const quotient = thisScaled / other._value;

    return Decimal.fromScaledBigInt(quotient, targetScale);
  }

  /**
   * Compares two Decimal numbers.
   * @param other The other Decimal number to compare.
   * @returns 0 if equal, 1 if this > other, -1 if this < other.
   */
  compareTo(other: Decimal): number {
    const commonScale = Math.max(this._scale, other._scale);
    const thisScaled = this._value * (10n ** BigInt(commonScale - this._scale));
    const otherScaled = other._value * (10n ** BigInt(commonScale - other._scale));

    if (thisScaled === otherScaled) return 0;
    return thisScaled > otherScaled ? 1 : -1;
  }

  isZero(): boolean {
    return this._value === 0n;
  }

  isPositive(): boolean {
    return (this._value as BigInt) > (0 as BigInt);
  }

  isNegative(): boolean {
    return (this._value as BigInt) < (0 as BigInt);
  }
}

// ─── Shared positive-decimal parsing (revenue / distribution amounts) ─────────

/**
 * @notice Validation limits for monetary decimal strings, mirroring
 *         `RevenueService.submitReport` (DB columns are NUMERIC(30,10)):
 *         up to 20 integer digits and 10 fractional digits.
 *
 * @dev The digit-length bounds are equivalent to the `MAX_AMOUNT` magnitude
 *      check used by RevenueService: any value with at most 20 integer digits
 *      and at most 10 fractional digits is <= 99999999999999999999.9999999999,
 *      so the length checks subsume the comparison without any float math.
 */
export const POSITIVE_DECIMAL_LIMITS = {
  /** Maximum number of integer digits before the decimal point. */
  MAX_INTEGER_DIGITS: 20,
  /** Maximum number of fractional digits after the decimal point. */
  MAX_DECIMAL_PLACES: 10,
} as const;

// Plain decimal strings only: no sign ("-5"), no exponent ("1e3", "1e-7"),
// no hex ("0x10"), no surrounding or embedded whitespace (" 12 "), and no
// thousands separators. Anchored with only bounded/simple quantifiers, so it
// runs in linear time (no catastrophic backtracking / ReDoS).
const PLAIN_POSITIVE_DECIMAL_REGEX = /^\d+(\.\d+)?$/;

/**
 * @notice Parses an untrusted value into a strictly positive, plain decimal
 *         string — the canonical representation carried end to end through the
 *         revenue and distribution paths.
 *
 * @dev Replaces `Number(value)`-style coercion, which silently accepts
 *      exponent/hex/whitespace forms and destroys precision above ~15
 *      significant digits (e.g. `Number("12345678901234567.89")` becomes
 *      `12345678901234568`). Only strings are accepted: JSON numbers are
 *      rejected so callers must submit decimal strings and no float can enter
 *      the amount pipeline.
 *
 * Security assumptions:
 * - The input is treated as attacker-controlled: the strict anchored grammar
 *   rejects every non-canonical numeric form before any parsing occurs.
 * - Zero and negative values are rejected; magnitude is bounded by digit
 *   counts (NUMERIC(30,10)) with no floating-point comparison.
 *
 * @param raw The untrusted value (must be a string).
 * @param field Field name used in error messages (e.g. `revenue_amount`).
 * @returns The validated decimal string, unchanged.
 * @throws {AppError} HTTP 400 (`VALIDATION_ERROR`) if the value is not a
 *         string, is not a plain decimal, exceeds the NUMERIC(30,10) limits,
 *         or is not greater than zero.
 */
export function parsePositiveDecimal(raw: unknown, field = 'amount'): string {
  if (typeof raw !== 'string') {
    throw Errors.validationError(
      `Invalid ${field}: expected a decimal string (e.g. "1234.56"), received ${
        raw === null ? 'null' : typeof raw
      }`,
      { field, receivedType: raw === null ? 'null' : typeof raw },
    );
  }

  if (!PLAIN_POSITIVE_DECIMAL_REGEX.test(raw)) {
    throw Errors.validationError(
      `Invalid ${field}: must be a plain decimal string (no sign, exponent, hex or whitespace)`,
      { field },
    );
  }

  const [integerPart, fractionalPart = ''] = raw.split('.');

  if (integerPart.length > POSITIVE_DECIMAL_LIMITS.MAX_INTEGER_DIGITS) {
    throw Errors.validationError(
      `Invalid ${field}: exceeds maximum integer digits of ${POSITIVE_DECIMAL_LIMITS.MAX_INTEGER_DIGITS}`,
      { field },
    );
  }

  if (fractionalPart.length > POSITIVE_DECIMAL_LIMITS.MAX_DECIMAL_PLACES) {
    throw Errors.validationError(
      `Invalid ${field}: decimal places exceed maximum ${POSITIVE_DECIMAL_LIMITS.MAX_DECIMAL_PLACES} places`,
      { field },
    );
  }

  // At least one non-zero digit anywhere ⇒ value > 0 (exact, no float math).
  if (!/[1-9]/.test(raw)) {
    throw Errors.validationError(`${field} must be > 0`, { field });
  }

  return raw;
}