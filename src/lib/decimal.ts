import { AppError, ErrorCode } from './errors';

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
  private readonly _value: BigInt; // Scaled integer value
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
        `Invalid decimal string format: "${decimalString}". Must be a numeric string with up to 18 decimal places.`,
        400,
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
   * Returns the decimal value as a string.
   */
  toString(): string {
    if (this._scale === 0) {
      return this._value.toString();
    }

    const valueStr = this._value.toString();
    const integerPartLength = valueStr.length - this._scale;

    if (integerPartLength <= 0) {
      // e.g., 0.001 for value=1, scale=3
      return `0.${'0'.repeat(-integerPartLength)}${valueStr}`;
    }

    const integerPart = valueStr.substring(0, integerPartLength);
    const fractionalPart = valueStr.substring(integerPartLength).padEnd(this._scale, '0');

    return `${integerPart}.${fractionalPart}`;
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
  toSorobanI128(targetScale: number, roundingMode: 'round' | 'floor' | 'ceil' | 'truncate' = 'round'): BigInt {
    if (targetScale < 0 || targetScale > 18) { // Common max scale for Stellar is 7, but 18 is max for input.
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Invalid target scale for Soroban i128 conversion: ${targetScale}. Must be between 0 and 18.`,
        500
      );
    }

    let scaledValue: BigInt;
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
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Decimal value ${this.toString()} exceeds Soroban i128 limits after scaling to ${targetScale} decimals.`,
        400,
        { value: this.toString(), scaledValue: scaledValue.toString(), targetScale }
      );
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
  static fromScaledBigInt(scaledValue: BigInt, scale: number): Decimal {
    if (scale < 0 || scale > 18) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Invalid scale for Decimal.fromScaledBigInt: ${scale}. Must be between 0 and 18.`,
        500
      );
    }

    const divisor = 10n ** BigInt(scale);

    // Handle negative values explicitly to avoid producing strings like "123.-05".
    const isNegative = scaledValue < 0n;
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
      throw new AppError(ErrorCode.BAD_REQUEST, 'Division by zero', 400);
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
    return this._value > 0n;
  }

  isNegative(): boolean {
    return this._value < 0n;
  }
}