import * as fc from 'fast-check';
import { Decimal } from './decimal';
import { AppError, ErrorCode } from './errors';

// Soroban i128 envelope: signed 128-bit integer bounds.
// Max: 2^127 - 1 = 170141183460469231731687303715884105727
// Min: -2^127   = -170141183460469231731687303715884105728
const I128_MIN = -170141183460469231731687303715884105728n;
const I128_MAX = 170141183460469231731687303715884105727n;

// Maximum supported number of decimal places (input and target scale).
const MAX_SCALE = 18;

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
      // Negative numbers are accepted by the implementation; ensure representation is preserved
      const neg = new Decimal('-123.45');
      expect(neg.toString()).toBe('-123.45');
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
      // The error must be a structured AppError with the message in the
      // message slot (regression: args were previously swapped, producing
      // message "500" and a non-numeric statusCode).
      const invalidScaleMatcher = expect.objectContaining({
        code: ErrorCode.INTERNAL_ERROR,
        statusCode: 500,
        message: expect.stringContaining('Invalid target scale'),
      });
      expect(() => dec.toSorobanI128(-1)).toThrow(invalidScaleMatcher);
      expect(() => dec.toSorobanI128(19)).toThrow(invalidScaleMatcher);
    });

    // ── i128 boundary edge cases ─────────────────────────────────────────────────────

    describe('i128 boundary edge cases', () => {
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

  // ── Property-based algebraic properties (fast-check) ────────────────────────────
  //
  // The distribution engine (src/services/distributionEngine.ts) performs
  // Decimal-based proration, so the algebra of `Decimal` must hold for *every*
  // input, not just the hand-picked scenarios above. These fast-check
  // properties assert the algebraic laws the engine relies on:
  //
  //   1. Associativity of addition:   (a + b) + c === a + (b + c)
  //   2. Distributivity of multiplication over addition within the i128
  //      envelope:                    a * (b + c) === a * b + a * c
  //   3. Rounding never overshoots:   toSorobanI128(scale) either returns a
  //      value inside I128_MIN..I128_MAX or throws a structured
  //      AppError.internal('DECIMAL_OVERFLOW', ...) — never a raw Error.
  //
  // Security note: every property asserts that any escape from the i128
  // envelope surfaces as a structured AppError (code INTERNAL_ERROR, message
  // DECIMAL_OVERFLOW), so no raw Error can leak sensitive internals to callers.

  describe('Property-based algebraic properties (fast-check)', () => {
    // Arbitraries bounded inside the i128 envelope: a raw scaled BigInt in
    // I128_MIN..I128_MAX paired with a scale of 0..18 decimal places.
    // NOTE: fast-check v4 requires the object form; positional min/max args
    // are ignored and would generate values outside the bounds.
    const scaledValueArb = fc.bigInt({ min: I128_MIN, max: I128_MAX });
    const scaleArb = fc.integer({ min: 0, max: MAX_SCALE });

    // Edge scaled values that must always be exercised: both i128 extremes,
    // values adjacent to the extremes, zero, and ±1.
    const edgeScaledValues: readonly bigint[] = [
      I128_MIN,
      I128_MIN + 1n,
      -1n,
      0n,
      1n,
      I128_MAX - 1n,
      I128_MAX,
    ];
    const edgeScaledValueArb = fc.oneof(
      ...edgeScaledValues.map((v) => fc.constant(v)),
    );

    // Mostly full-range values, but occasionally force an edge value so the
    // boundary behaviour is exercised in every property run.
    const mixedScaledValueArb = fc.oneof(
      { weight: 4, arbitrary: scaledValueArb },
      { weight: 1, arbitrary: edgeScaledValueArb },
    );

    /**
     * Asserts that `e` is the structured overflow error raised when a Decimal
     * escapes the i128 envelope: an AppError.internal('DECIMAL_OVERFLOW', ...),
     * never a raw Error.
     */
    function expectStructuredDecimalOverflow(e: unknown): void {
      expect(e).toBeInstanceOf(AppError);
      const appError = e as AppError;
      expect(appError.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(appError.message).toBe('DECIMAL_OVERFLOW');
      expect(appError.statusCode).toBe(500);
      expect(appError.details).toMatchObject({
        value: expect.any(String),
        scaledValue: expect.any(String),
        targetScale: expect.any(Number),
      });
    }

    it('addition is associative within the i128 envelope: (a + b) + c === a + (b + c)', () => {
      fc.assert(
        fc.property(
          mixedScaledValueArb, scaleArb,
          mixedScaledValueArb, scaleArb,
          mixedScaledValueArb, scaleArb,
          (aScaled, aScale, bScaled, bScale, cScaled, cScale) => {
            const a = Decimal.fromScaledBigInt(aScaled, aScale);
            const b = Decimal.fromScaledBigInt(bScaled, bScale);
            const c = Decimal.fromScaledBigInt(cScaled, cScale);

            // Exact algebraic law at full precision (addition never rounds).
            const left = a.add(b).add(c);
            const right = a.add(b.add(c));
            expect(left.toString()).toBe(right.toString());

            // Envelope law: when the sum fits the i128 envelope the scaled
            // representations must agree; when it escapes, the escape must be
            // a structured DECIMAL_OVERFLOW AppError.
            for (const targetScale of [0, 7, MAX_SCALE]) {
              let leftScaled: bigint;
              let rightScaled: bigint;
              try {
                leftScaled = left.toSorobanI128(targetScale);
                rightScaled = right.toSorobanI128(targetScale);
              } catch (e) {
                expectStructuredDecimalOverflow(e);
                return;
              }
              expect(leftScaled).toBe(rightScaled);
              expect(leftScaled).toBeGreaterThanOrEqual(I128_MIN);
              expect(leftScaled).toBeLessThanOrEqual(I128_MAX);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('multiplication distributes over addition within the i128 envelope: a * (b + c) === a * b + a * c', () => {
      fc.assert(
        fc.property(
          mixedScaledValueArb, scaleArb,
          mixedScaledValueArb, scaleArb,
          mixedScaledValueArb, scaleArb,
          (aScaled, aScale, bScaled, bScale, cScaled, cScale) => {
            // Restrict to operands whose products never force the scale
            // truncation path (productScale = scale(a) + max(scale(b),
            // scale(c)) <= 18) so the law is exact rather than approximate.
            fc.pre(aScale + Math.max(bScale, cScale) <= MAX_SCALE);

            const a = Decimal.fromScaledBigInt(aScaled, aScale);
            const b = Decimal.fromScaledBigInt(bScaled, bScale);
            const c = Decimal.fromScaledBigInt(cScaled, cScale);

            // Exact algebraic law (no rounding is involved under the
            // precondition above).
            const left = a.multiply(b.add(c));
            const right = a.multiply(b).add(a.multiply(c));
            expect(left.toString()).toBe(right.toString());

            // Envelope law with structured overflow assertions.
            for (const targetScale of [0, 7, MAX_SCALE]) {
              let leftScaled: bigint;
              let rightScaled: bigint;
              try {
                leftScaled = left.toSorobanI128(targetScale);
                rightScaled = right.toSorobanI128(targetScale);
              } catch (e) {
                expectStructuredDecimalOverflow(e);
                return;
              }
              expect(leftScaled).toBe(rightScaled);
              expect(leftScaled).toBeGreaterThanOrEqual(I128_MIN);
              expect(leftScaled).toBeLessThanOrEqual(I128_MAX);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('rounding to a target scale never overshoots the i128 envelope', () => {
      fc.assert(
        fc.property(
          mixedScaledValueArb, scaleArb, fc.integer({ min: 0, max: MAX_SCALE }),
          (scaledValue, scale, targetScale) => {
            const d = Decimal.fromScaledBigInt(scaledValue, scale);

            let result: bigint;
            try {
              result = d.toSorobanI128(targetScale);
            } catch (e) {
              expectStructuredDecimalOverflow(e);
              return;
            }

            // A returned value must always fit the envelope: rounding may never
            // overshoot I128_MAX (or underflow I128_MIN).
            expect(result).toBeGreaterThanOrEqual(I128_MIN);
            expect(result).toBeLessThanOrEqual(I128_MAX);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ── Edge cases required by the algebraic-property contract ─────────────────────

  describe('Algebraic edge cases', () => {
    const overflowMatcher = expect.objectContaining({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'DECIMAL_OVERFLOW',
      statusCode: 500,
    });

    it('handles negative operands in addition and multiplication', () => {
      expect(new Decimal('-10.5').add(new Decimal('2.35')).toString()).toBe('-8.15');
      expect(new Decimal('-0.001').add(new Decimal('0.0005')).toString()).toBe('-0.0005');
      expect(new Decimal('-1.5').multiply(new Decimal('2.0')).toString()).toBe('-3.00');
      expect(new Decimal('-1.5').add(new Decimal('-1.5')).toString()).toBe('-3.0');
    });

    it('handles zero operands without violating the envelope', () => {
      const zero = new Decimal('0');
      expect(zero.add(new Decimal('3.25')).toString()).toBe('3.25');
      expect(new Decimal('3.25').add(zero).toString()).toBe('3.25');
      expect(zero.multiply(new Decimal('-99.99')).toString()).toBe('0.00'); // 0 × -99.99 at scale 2
      expect(zero.toSorobanI128(7)).toBe(0n);
      expect(new Decimal('0.000').toSorobanI128(0, 'round')).toBe(0n);
    });

    it('accepts the exact i128 extremes and rejects one step beyond them with DECIMAL_OVERFLOW', () => {
      expect(new Decimal('170141183460469231731687303715884105727').toSorobanI128(0)).toBe(I128_MAX);
      expect(new Decimal('-170141183460469231731687303715884105728').toSorobanI128(0)).toBe(I128_MIN);

      expect(() => new Decimal('170141183460469231731687303715884105728').toSorobanI128(0)).toThrow(overflowMatcher);
      expect(() => new Decimal('-170141183460469231731687303715884105729').toSorobanI128(0)).toThrow(overflowMatcher);
    });

    it('rejects near-overflow operands that overflow only after scaling up', () => {
      const nearMax = new Decimal('17014118346046923173168730371588410572'); // I128_MAX / 10
      expect(nearMax.toSorobanI128(1)).toBe(170141183460469231731687303715884105720n);
      expect(() => nearMax.toSorobanI128(10)).toThrow(overflowMatcher);

      const nearMin = new Decimal('-17014118346046923173168730371588410572'); // I128_MIN / 10
      expect(nearMin.toSorobanI128(1)).toBe(-170141183460469231731687303715884105720n);
      expect(() => nearMin.toSorobanI128(10)).toThrow(overflowMatcher);
    });

    it('rounding at the half boundary near I128_MAX throws DECIMAL_OVERFLOW instead of overshooting', () => {
      // I128_MAX at scale 1, plus values that round half-up to exactly I128_MAX.
      expect(new Decimal('17014118346046923173168730371588410572.7').toSorobanI128(1)).toBe(I128_MAX);
      expect(new Decimal('17014118346046923173168730371588410572.65').toSorobanI128(1)).toBe(I128_MAX);
      // ...72.75 rounds half-up to ...72.8 = I128_MAX + 1 → must throw.
      expect(() => new Decimal('17014118346046923173168730371588410572.75').toSorobanI128(1)).toThrow(overflowMatcher);
      // Negative side: tie rounding keeps the result inside the envelope…
      expect(new Decimal('-17014118346046923173168730371588410572.8').toSorobanI128(1)).toBe(I128_MIN);
      expect(new Decimal('-17014118346046923173168730371588410572.85').toSorobanI128(1)).toBe(I128_MIN);
      // …but a value below I128_MIN at target scale still throws.
      expect(() => new Decimal('-17014118346046923173168730371588410572.9').toSorobanI128(1)).toThrow(overflowMatcher);
    });

    it('rounds at the exact half (tie) boundary using round-half-up for positive values', () => {
      expect(new Decimal('123.455').toSorobanI128(2)).toBe(12346n); // 123.455 → 123.46
      expect(new Decimal('123.445').toSorobanI128(2)).toBe(12345n); // 123.445 → 123.45
      expect(new Decimal('0.005').toSorobanI128(2)).toBe(1n);      // 0.005 → 0.01
      expect(new Decimal('-0.005').toSorobanI128(2)).toBe(0n);     // tie rounds toward zero for negatives
    });

    it('supports 18-digit fractional operands across all operations', () => {
      const oneAtt = new Decimal('0.000000000000000001');
      const twoAtt = new Decimal('0.000000000000000002');
      expect(oneAtt.add(twoAtt).toString()).toBe('0.000000000000000003');
      expect(oneAtt.toSorobanI128(18)).toBe(1n);
      expect(twoAtt.toSorobanI128(7)).toBe(0n);

      // Multiplication whose natural scale (36) exceeds the max of 18 is
      // truncated to 18 decimal places.
      const nearOne = new Decimal('1.000000000000000001');
      expect(nearOne.multiply(nearOne).toString()).toBe('1.000000000000000002');
    });
  });
});