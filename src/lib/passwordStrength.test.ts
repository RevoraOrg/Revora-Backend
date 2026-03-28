import { validatePasswordStrength } from './passwordStrength';

describe('validatePasswordStrength', () => {
  it('should accept a strong password', () => {
    const result = validatePasswordStrength('StrongP@ssw0rd!');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject password shorter than 12 characters', () => {
    const result = validatePasswordStrength('Short1!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password must be at least 12 characters long');
  });

  it('should reject password longer than 128 characters', () => {
    const longPassword = 'A'.repeat(129) + '1!';
    const result = validatePasswordStrength(longPassword);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password must be no more than 128 characters long');
  });

  it('should reject password without uppercase letter', () => {
    const result = validatePasswordStrength('strongp@ssw0rd123!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password must contain at least one uppercase letter');
  });

  it('should reject password without lowercase letter', () => {
    const result = validatePasswordStrength('STRONGP@SSW0RD123!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password must contain at least one lowercase letter');
  });

  it('should reject password without digit', () => {
    const result = validatePasswordStrength('StrongP@ssword!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password must contain at least one number');
  });

  it('should reject password without special character', () => {
    const result = validatePasswordStrength('StrongPassword123');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password must contain at least one special character');
  });

  it('should reject common passwords', () => {
    const result = validatePasswordStrength('password');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password is too common; please choose a stronger password');
  });

  it('should reject passwords with excessive repeated characters', () => {
    const result = validatePasswordStrength('AAAAA1!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password must not contain excessive repeated characters');
  });

  it('should reject passwords with sequential characters', () => {
    const result = validatePasswordStrength('abcde1!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password must not contain sequential characters');
  });

  it('should reject null or undefined password', () => {
    const result = validatePasswordStrength('');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password is required');
  });

  it('should handle multiple errors', () => {
    const result = validatePasswordStrength('short');
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});