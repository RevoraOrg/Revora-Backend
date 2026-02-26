import { sanitizeString, sanitizeObject } from './sanitize';

describe('sanitizeString', () => {
  it('strips script tags', () => {
    const input = '<script>alert(1)</script>Hello';
    expect(sanitizeString(input)).toBe('Hello');
  });

  it('removes html tags', () => {
    const input = '<b onclick="x">Hi</b> there <img src=x onerror=1>';
    expect(sanitizeString(input)).toBe('Hi there');
  });

  it('collapses whitespace and trims', () => {
    const input = '  a   b \n c   ';
    expect(sanitizeString(input)).toBe('a b c');
  });

  it('respects allowNewlines', () => {
    const input = 'a  \n  b\n\n\nc';
    expect(sanitizeString(input, { allowNewlines: true })).toBe('a\nb\n\nc');
  });

  it('limits length', () => {
    const input = 'x'.repeat(200);
    expect(sanitizeString(input, { maxLength: 50 }).length).toBe(50);
  });

  it('handles nullish input', () => {
    expect(sanitizeString(undefined)).toBe('');
    expect(sanitizeString(null)).toBe('');
  });
});

describe('sanitizeObject', () => {
  it('sanitizes specified fields by path', () => {
    const input = {
      name: ' <b>Alice</b> ',
      profile: { bio: '<script>x</script>Hi  there' },
      tags: [' <i>one</i> ', ' two  '],
    };
    const out = sanitizeObject(input, {
      'name': true,
      'profile.bio': { allowNewlines: false, maxLength: 20 },
      'tags': { type: 'string[]' },
    });
    expect(out.name).toBe('Alice');
    expect(out.profile.bio).toBe('Hi there');
    expect(out.tags).toEqual(['one', 'two']);
  });
});
