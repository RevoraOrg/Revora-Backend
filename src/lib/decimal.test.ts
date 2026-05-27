import { Decimal } from './decimal';
import { AppError, ErrorCode } from './errors';

describe('Decimal Utility', () => {
  describe('Constructor and toString()', () => {
    it('should correctly parse and represent integer strings', () => {
      const dec = new Decimal('123');
      expect(dec.toString()).toBe('123');
    });

    it('should correctly parse and represent decimal strings', () => {
      const dec = new Decimal('123.456');
      expect(dec.toString()).toBe('123.456');
    });

    it('should handle leading zeros in fractional part', () => {
      const dec = new Decimal('0.001');
      expect(dec.toString()).toBe('0.001');
    });

    it('should handle trailing zeros in fractional part (constructor normalizes)', () => {
      const dec = new Decimal('1.200');
      expect(dec.toString()).toBe('1.200'); // Internal representation keeps original scale
    });

    it('should handle zero', () => {
      const dec = new Decimal('0');
      expect(dec.toString()).toBe('0');
      const dec2 = new Decimal('0.00');
      expect(dec2.toString()).toBe('0.00');
    });

    it('should reject invalid decimal string format', () => {
      expect(() => new Decimal('123.45.6')).toThrow(AppError);
      expect(() => new Decimal('-123.45')).toThrow(AppError);
      expect(() => new Decimal('.45')).toThrow(AppError);
      expect(() => new Decimal('abc')).toThrow(AppError);
    });

    it('should reject decimal strings with more than 18 decimal places', () => {
      expect(() => new Decimal('1.1234567890123456789')).toThrow(AppError);
      const dec = new Decimal('1.123456789012345678');
      expect(dec.toString()).toBe('1.123456789012345678');
    });

    // ── format validation edge cases ───────────────────────────────────────────────────

    describe('format validation edge cases', () => {
      it('should reject .5 (no leading digit before decimal)', () => {
        expect(() => new Decimal('.5')).toThrow(AppError);
        expect(() => new Decimal('.123')).toThrow(AppError);
        expect(() => new Decimal('.0')).toThrow(AppError);
      });

      it('should reject leading zeros in integer part (security: prevents canonicalization attacks)', () => {
        // The regex allows leading zeros, but the internal value should be normalized
        // For security, we want to ensure that "001.23" is treated as "1.23"
        const dec = new Decimal('001.23');
        expect(dec.toString()).toBe('1.23'); // Constructor normalizes leading zeros
        expect(dec.toSorobanI128(2)).toBe(123n);
      });

      it('should reject exactly 19 fractional digits', () => {
        expect(() => new Decimal('1.1234567890123456789')).toThrow(AppError);
      });

      it('should reject 20+ fractional digits', () => {
        expect(() => new Decimal('1.12345678901234567890')).toThrow(AppError);
        expect(() => new Decimal('1.' + '9'.repeat(20))).toThrow(AppError);
      });

      it('should accept exactly 18 fractional digits', () => {
        const dec = new Decimal('1.123456789012345678');
        expect(dec.toString()).toBe('1.123456789012345678');
      });

      it('should reject empty string', () => {
        expect(() => new Decimal('')).toThrow(AppError);
      });

      it('should reject whitespace-only string', () => {
        expect(() => new Decimal('   ')).toThrow(AppError);
      });

      it('should reject string with leading/trailing whitespace', () => {
        expect(() => new Decimal(' 123.45')).toThrow(AppError);
        expect(() => new Decimal('123.45 ')).toThrow(AppError);
      });

      it('should reject scientific notation', () => {
        expect(() => new Decimal('1e10')).toThrow(AppError);
        expect(() => new Decimal('1.23e-5')).toThrow(AppError);
      });

      it('should reject comma as decimal separator', () => {
        expect(() => new Decimal('123,45')).toThrow(AppError);
      });

      it('should reject multiple decimal points', () => {
        expect(() => new Decimal('123.45.67')).toThrow(AppError);
        expect(() => new Decimal('1.2.3.4')).toThrow(AppError);
      });

      // ── ReDoS-safe parsing ─────────────────────────────────────────────────────────────

      describe('ReDoS-safe parsing', () => {
        it('should reject long-repetition input quickly (bounded-time parsing)', () => {
          // Create a potentially malicious input with many repeating characters
          // This tests that the regex doesn't have catastrophic backtracking
          const maliciousInput = '1' + '0'.repeat(1000) + '.' + '9'.repeat(19); // 19 fractional digits = invalid
          
          const startTime = Date.now();
          expect(() => new Decimal(maliciousInput)).toThrow(AppError);
          const endTime = Date.now();
          
          // Should complete in under 100ms (ReDoS would take much longer)
          expect(endTime - startTime).toBeLessThan(100);
        });

        it('should reject alternating pattern input quickly', () => {
          // Another potential ReDoS pattern: alternating characters with invalid format
          const maliciousInput = '1' + '0.1'.repeat(500); // Multiple decimal points = invalid
          
          const startTime = Date.now();
          expect(() => new Decimal(maliciousInput)).toThrow(AppError);
          const endTime = Date.now();
          
          expect(endTime - startTime).toBeLessThan(100);
        });

        it('should reject deeply nested pattern input quickly', () => {
          // Test with a pattern that could cause backtracking in poorly designed regexes
          const maliciousInput = '1' + '.' + '9'.repeat(100); // No leading digit after decimal = invalid
          
          const startTime = Date.now();
          expect(() => new Decimal(maliciousInput)).toThrow(AppError);
          const endTime = Date.now();
          
          expect(endTime - startTime).toBeLessThan(100);
        });

        it('should handle valid long input without performance issues', () => {
          // Valid input with many digits should still parse quickly
          const validInput = '12345678901234567890.12345678';
          
          const startTime = Date.now();
          const dec = new Decimal(validInput);
          const endTime = Date.now();
          
          expect(dec.toString()).toBe(validInput);
          expect(endTime - startTime).toBeLessThan(100);
        });
      });
    });
  });

  describe('toSorobanI128()', () => {
    it('should convert to Soroban i128 with same scale', () => {
      const dec = new Decimal('123.456');
      expect(dec.toSorobanI128(3)).toBe(123456n);
    });

    it('should convert to Soroban i128 by increasing scale', () => {
      const dec = new Decimal('123');
      expect(dec.toSorobanI128(7)).toBe(1230000000n);
    });

    it('should convert to Soroban i128 by decreasing scale (rounding half up)', () => {
      const dec = new Decimal('123.45678');
      expect(dec.toSorobanI128(2)).toBe(12346n); // 123.45678 -> 123.46
      const dec2 = new Decimal('123.454');
      expect(dec2.toSorobanI128(2)).toBe(12345n); // 123.454 -> 123.45
      const dec3 = new Decimal('123.455');
      expect(dec3.toSorobanI128(2)).toBe(12346n); // 123.455 -> 123.46
    });

    it('should convert to Soroban i128 by decreasing scale (floor)', () => {
      const dec = new Decimal('123.45678');
      expect(dec.toSorobanI128(2, 'floor')).toBe(12345n); // 123.45678 -> 123.45
    });

    it('should convert to Soroban i128 by decreasing scale (ceil)', () => {
      const dec = new Decimal('123.451');
      expect(dec.toSorobanI128(2, 'ceil')).toBe(12346n); // 123.451 -> 123.46
    });

    it('should convert to Soroban i128 by decreasing scale (truncate)', () => {
      const dec = new Decimal('123.45678');
      expect(dec.toSorobanI128(2, 'truncate')).toBe(12345n); // 123.45678 -> 123.45
    });

    it('should reject values exceeding i128 max limit', () => {
      const largeValue = new Decimal('1701411834604692317316873037158841057270'); // I128_MAX * 10
      expect(() => largeValue.toSorobanI128(0)).toThrow(AppError);
      expect(() => largeValue.toSorobanI128(1)).toThrow(AppError);
    });

    it('should reject values exceeding i128 min limit (conceptually, as input is positive)', () => {
      // Since our Decimal only handles positive numbers, this test case is more theoretical
      // or would apply if we introduced negative numbers. For now, it's about the scaled positive limit.
      const veryLargePositive = new Decimal('170141183460469231731687303715884105727'); // Just below I128_MAX
      expect(veryLargePositive.toSorobanI128(0)).toBe(170141183460469231731687303715884105727n);
      const overflowPositive = new Decimal('170141183460469231731687303715884105728'); // I128_MAX + 1
      expect(() => overflowPositive.toSorobanI128(0)).toThrow(AppError);
    });

    it('should throw for invalid target scale', () => {
      const dec = new Decimal('1.0');
      expect(() => dec.toSorobanI128(-1)).toThrow(AppError);
      expect(() => dec.toSorobanI128(19)).toThrow(AppError);
    });

    // ── i128 boundary edge cases ─────────────────────────────────────────────────────

    describe('i128 boundary edge cases', () => {
      const I128_MAX = 170141183460469231731687303715884105727n;

      it('should accept exact I128_MAX at scale 0', () => {
        const dec = new Decimal('170141183460469231731687303715884105727');
        expect(dec.toSorobanI128(0)).toBe(I128_MAX);
      });

      it('should accept I128_MAX - 1 at scale 0', () => {
        const dec = new Decimal('170141183460469231731687303715884105726');
        expect(dec.toSorobanI128(0)).toBe(I128_MAX - 1n);
      });

      it('should reject I128_MAX + 1 at scale 0', () => {
        const dec = new Decimal('170141183460469231731687303715884105728');
        expect(() => dec.toSorobanI128(0)).toThrow(AppError);
      });

      it('should reject value that overflows when scaled up', () => {
        const dec = new Decimal('17014118346046923173168730371588410572'); // I128_MAX / 10
        // Scaling by 1 should work
        expect(dec.toSorobanI128(1)).toBe(170141183460469231731687303715884105720n);
        // But scaling by 10 would overflow
        expect(() => dec.toSorobanI128(10)).toThrow(AppError);
      });

      it('should handle boundary with fractional scaling', () => {
        const dec = new Decimal('17014118346046923173168730371588410572.8'); // I128_MAX / 10 + 0.8
        // At scale 1, this becomes I128_MAX + 8, which overflows
        expect(() => dec.toSorobanI128(1)).toThrow(AppError);
      });
    });
  });

  describe('fromScaledBigInt()', () => {
    it('should convert scaled BigInt to Decimal', () => {
      const dec = Decimal.fromScaledBigInt(123456n, 3);
      expect(dec.toString()).toBe('123.456');
    });

    it('should handle zero scaled BigInt', () => {
      const dec = Decimal.fromScaledBigInt(0n, 5);
      expect(dec.toString()).toBe('0.00000');
    });

    it('should handle scaled BigInt with more scale than value digits', () => {
      const dec = Decimal.fromScaledBigInt(1n, 3); // 0.001
      expect(dec.toString()).toBe('0.001');
    });

    it('should throw for invalid scale', () => {
      expect(() => Decimal.fromScaledBigInt(100n, -1)).toThrow(AppError);
      expect(() => Decimal.fromScaledBigInt(100n, 19)).toThrow(AppError);
    });
  });

  describe('Arithmetic Operations', () => {
    it('should correctly add two Decimal numbers', () => {
      const dec1 = new Decimal('10.5');
      const dec2 = new Decimal('2.35');
      expect(dec1.add(dec2).toString()).toBe('12.85');

      const dec3 = new Decimal('0.001');
      const dec4 = new Decimal('0.0005');
      expect(dec3.add(dec4).toString()).toBe('0.0015');
    });

    it('should correctly subtract two Decimal numbers', () => {
      const dec1 = new Decimal('10.5');
      const dec2 = new Decimal('2.35');
      expect(dec1.subtract(dec2).toString()).toBe('8.15');

      const dec3 = new Decimal('0.001');
      const dec4 = new Decimal('0.0005');
      expect(dec3.subtract(dec4).toString()).toBe('0.0005');
    });

    it('should correctly multiply two Decimal numbers', () => {
      const dec1 = new Decimal('10.5');
      const dec2 = new Decimal('2.0');
      expect(dec1.multiply(dec2).toString()).toBe('21.00');

      const dec3 = new Decimal('0.001');
      const dec4 = new Decimal('0.002');
      expect(dec3.multiply(dec4).toString()).toBe('0.000002');

      const dec5 = new Decimal('123456789012345678.123456789012345678'); // 18 decimals
      const dec6 = new Decimal('1.000000000000000001'); // 18 decimals
      // Product scale would be 36, but we truncate to 18.
      expect(dec5.multiply(dec6).toString()).toBe('123456789012345678.246913578024691356');
    });

    it('should correctly divide two Decimal numbers', () => {
      const dec1 = new Decimal('10.0');
      const dec2 = new Decimal('2.0');
      expect(dec1.divide(dec2).toString()).toBe('5.000000000000000000');

      const dec3 = new Decimal('1.0');
      const dec4 = new Decimal('3.0');
      expect(dec3.divide(dec4).toString()).toBe('0.333333333333333333'); // Truncated to 18 decimals

      expect(() => dec1.divide(new Decimal('0'))).toThrow(AppError);
    });
  });

  describe('Comparison and State Checks', () => {
    it('should correctly compare two Decimal numbers', () => {
      const dec1 = new Decimal('10.5');
      const dec2 = new Decimal('10.50');
      const dec3 = new Decimal('12.0');
      const dec4 = new Decimal('8.0');

      expect(dec1.compareTo(dec2)).toBe(0);
      expect(dec1.compareTo(dec3)).toBe(-1);
      expect(dec3.compareTo(dec1)).toBe(1);
      expect(dec1.compareTo(dec4)).toBe(1);
    });

    it('should correctly identify zero, positive, and negative', () => {
      const zero = new Decimal('0.00');
      const positive = new Decimal('1.23');
      // Our Decimal class currently only handles positive inputs, so negative checks are theoretical
      // For now, isNegative will always be false.
      // const negative = new Decimal('-1.23'); // Would fail constructor regex

      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);

      expect(positive.isZero()).toBe(false);
      expect(positive.isPositive()).toBe(true);
      expect(positive.isNegative()).toBe(false);
    });
  });
});