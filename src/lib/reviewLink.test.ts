import { sanitizeReviewLink } from './reviewLink';

describe('sanitizeReviewLink', () => {
  it('allows a clean relative internal path', () => {
    expect(sanitizeReviewLink('/api/v1/aml/ofac-reviews')).toBe('/api/v1/aml/ofac-reviews');
  });

  it('rejects non-string input', () => {
    expect(sanitizeReviewLink(null as unknown as string)).toBe('');
  });

  it('rejects empty and overlong input', () => {
    expect(sanitizeReviewLink('')).toBe('');
    expect(sanitizeReviewLink('a'.repeat(513))).toBe('');
  });

  it('rejects absolute URLs with a scheme/host', () => {
    expect(sanitizeReviewLink('https://evil.example.com/x')).toBe('');
  });

  it('rejects path-traversal and bare-double-slash forms', () => {
    expect(sanitizeReviewLink('/a/../b')).toBe('');
    expect(sanitizeReviewLink('//evil.example.com')).toBe('');
  });

  it('rejects disallowed characters', () => {
    expect(sanitizeReviewLink('/api/v1/<script>')).toBe('');
  });

  it('sanitizes to empty so a caller never logs an unsafe link', () => {
    // Regression: confirms an unsafe value cannot be persisted as a link.
    expect(sanitizeReviewLink('javascript:alert(1)')).toBe('');
    expect(sanitizeReviewLink('https://example.com')).toBe('');
  });
});