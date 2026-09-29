import { sanitizeString, sanitizeObject, isSafeUrl, getByPath, setByPath } from './sanitize';
import { globalLogger } from './logger';

jest.mock('./logger', () => ({
  globalLogger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('isSafeUrl', () => {
  it('allows public http/https URLs', () => {
    expect(isSafeUrl('https://google.com')).toBe(true);
    expect(isSafeUrl('http://example.org/path')).toBe(true);
  });

  it('blocks private IP ranges', () => {
    expect(isSafeUrl('http://127.0.0.1')).toBe(false);
    expect(isSafeUrl('https://192.168.1.1')).toBe(false);
    expect(isSafeUrl('http://10.0.0.1')).toBe(false);
    expect(isSafeUrl('http://172.16.0.1')).toBe(false);
    expect(isSafeUrl('http://[::1]')).toBe(false);
  });

  it('blocks IPv6 bracket notations with private addresses', () => {
    expect(isSafeUrl('http://[fe80::1]')).toBe(false);
    expect(isSafeUrl('http://[127.0.0.1]')).toBe(false);
    expect(isSafeUrl('http://[10.0.0.1]')).toBe(false);
    expect(isSafeUrl('http://[192.168.1.1]')).toBe(false);
  });

  it('blocks localhost', () => {
    expect(isSafeUrl('http://localhost:3000')).toBe(false);
  });

  it('blocks non-http protocols', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,x')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('handles invalid URL in isSafeUrl catch block', () => {
    expect(isSafeUrl('not-a-url')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('http://')).toBe(false);
  });
});

describe('sanitizeString with safeHTML', () => {
  it('allows safe tags but strips dangerous attributes', () => {
    const input = '<b onclick="alert(1)">Bold</b> and <i style="color:red">Italic</i>';
    const output = sanitizeString(input, { safeHTML: true });
    expect(output).toBe('<b>Bold</b> and <i>Italic</i>');
  });

  it('strips disallowed tags', () => {
    const input = '<div>Div</div><script>alert(1)</script><span>Span</span>';
    const output = sanitizeString(input, { safeHTML: true });
    expect(output).toBe('DivSpan');
    expect(globalLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Stripping disallowed HTML tag'),
      expect.anything()
    );
  });

  it('sanitizes links with safe URLs (quoted, unquoted, single-quoted)', () => {
    const inputDouble = '<a href="https://safe.com" title="hi">Safe</a> and <a href="http://127.0.0.1">Unsafe</a>';
    expect(sanitizeString(inputDouble, { safeHTML: true })).toBe(
      '<a href="https://safe.com" rel="noopener noreferrer" target="_blank">Safe</a> and <a>Unsafe</a>'
    );

    const inputUnquoted = '<a href=https://safe.com/page>Safe Unquoted</a> and <a href=http://127.0.0.1/admin>Unsafe</a>';
    expect(sanitizeString(inputUnquoted, { safeHTML: true })).toBe(
      '<a href="https://safe.com/page" rel="noopener noreferrer" target="_blank">Safe Unquoted</a> and <a>Unsafe</a>'
    );

    const inputSingle = "<a href='https://safe.com/single'>Safe Single</a>";
    expect(sanitizeString(inputSingle, { safeHTML: true })).toBe(
      '<a href="https://safe.com/single" rel="noopener noreferrer" target="_blank">Safe Single</a>'
    );
  });

  it('sanitizes images with safe URLs (various attribute formats)', () => {
    const input = '<img src="https://safe.com/img.png" alt="safe"> and <img src="http://localhost/x.png">';
    const output = sanitizeString(input, { safeHTML: true });
    expect(output).toBe('<img src="https://safe.com/img.png" alt="safe"> and');

    const inputUnquoted = '<img src=https://safe.com/img.png alt=image>';
    expect(sanitizeString(inputUnquoted, { safeHTML: true })).toBe(
      '<img src="https://safe.com/img.png" alt="image">'
    );

    const inputSingle = "<img src='https://safe.com/img.png' alt='single quote'>";
    expect(sanitizeString(inputSingle, { safeHTML: true })).toBe(
      '<img src="https://safe.com/img.png" alt="single quote">'
    );
  });

  it('handles nested tags', () => {
    const input = '<p>Hello <b>World</b></p>';
    expect(sanitizeString(input, { safeHTML: true })).toBe('<p>Hello <b>World</b></p>');
  });
});

describe('sanitizeString edge cases and boundary behavior', () => {
  it('handles null and undefined input deterministically', () => {
    expect(sanitizeString(null)).toBe('');
    expect(sanitizeString(undefined)).toBe('');
  });

  it('handles maxLength truncations', () => {
    expect(sanitizeString('abcdefghij', { maxLength: 5 })).toBe('abcde');
    expect(sanitizeString('abc', { maxLength: 10 })).toBe('abc');
  });

  it('handles allowNewlines: false branch', () => {
    const input = 'line1\nline2';
    expect(sanitizeString(input, { allowNewlines: false })).toBe('line1 line2');
  });

  it('respects allowNewlines: true with multiple lines', () => {
    const input = 'line1  \n\n\n\n  line2';
    expect(sanitizeString(input, { allowNewlines: true })).toBe('line1\n\nline2');
  });

  it('handles normalize fallback gracefully', () => {
    const originalNormalize = String.prototype.normalize;
    try {
      // Temporarily mock normalize to throw to verify the catch/noop path
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (String.prototype as any).normalize = () => {
        throw new Error('normalize error');
      };
      expect(sanitizeString('test-string', { normalize: true })).toBe('test-string');
    } finally {
      String.prototype.normalize = originalNormalize;
    }
  });

  it('strips all html if stripHTML is true', () => {
    const input = '<b>Hi</b>';
    expect(sanitizeString(input, { stripHTML: true })).toBe('Hi');
  });

  it('collapses whitespace', () => {
    expect(sanitizeString('  a  b  ')).toBe('a b');
  });
});

describe('getByPath - line 171 branch evidence (cur == null)', () => {
  it('returns undefined when immediate child of null is traversed', () => {
    const obj = { user: null };
    expect(getByPath(obj, 'user.profile')).toBeUndefined();
  });

  it('returns undefined when immediate child of undefined is traversed', () => {
    const obj = { user: undefined };
    expect(getByPath(obj, 'user.profile')).toBeUndefined();
  });

  it('returns undefined on deep nullish intermediate path', () => {
    const obj = { a: { b: { c: null } } };
    expect(getByPath(obj, 'a.b.c.d.e')).toBeUndefined();
  });

  it('returns undefined on deep undefined intermediate path', () => {
    const obj = { a: { b: { c: undefined } } };
    expect(getByPath(obj, 'a.b.c.d')).toBeUndefined();
  });

  it('returns undefined when intermediate property does not exist on object', () => {
    const obj = { a: {} };
    expect(getByPath(obj, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined when root object itself is null or undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getByPath(null as any, 'a.b')).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getByPath(undefined as any, 'a.b')).toBeUndefined();
  });

  it('returns undefined when intermediate property is a primitive scalar (number, boolean, string)', () => {
    expect(getByPath({ a: 42 }, 'a.b.c')).toBeUndefined();
    expect(getByPath({ a: false }, 'a.b')).toBeUndefined();
    expect(getByPath({ a: 'scalar' }, 'a.b.c')).toBeUndefined();
  });

  it('preserves exact contract distinction between intermediate null (undefined) and leaf null (null)', () => {
    const objWithLeafNull = { a: { b: null } };
    // Terminal property is null -> returns null
    expect(getByPath(objWithLeafNull, 'a.b')).toBeNull();
    // Intermediate property is null -> returns undefined via line 171
    expect(getByPath(objWithLeafNull, 'a.b.c')).toBeUndefined();

    const rootLeafNull = { val: null };
    expect(getByPath(rootLeafNull, 'val')).toBeNull();
  });

  it('returns leaf values correctly on normal paths', () => {
    const obj = {
      user: {
        profile: {
          bio: 'Software Engineer',
          age: 30,
          verified: true,
          tags: ['backend', 'security'],
        },
      },
    };

    expect(getByPath(obj, 'user.profile.bio')).toBe('Software Engineer');
    expect(getByPath(obj, 'user.profile.age')).toBe(30);
    expect(getByPath(obj, 'user.profile.verified')).toBe(true);
    expect(getByPath(obj, 'user.profile.tags')).toEqual(['backend', 'security']);
  });

  it('handles boundary path inputs (empty string, consecutive dots, leading/trailing dots)', () => {
    const obj = {
      '': 'emptyKey',
      a: {
        '': 'trailingEmpty',
        b: 'validB',
      },
    };

    expect(getByPath(obj, '')).toBe('emptyKey');
    expect(getByPath({}, '')).toBeUndefined();
    expect(getByPath(obj, 'a..b')).toBeUndefined();
    expect(getByPath(obj, 'a.')).toBe('trailingEmpty');
    expect(getByPath({ a: 1 }, 'a.')).toBeUndefined();
    expect(getByPath({ '': { a: 'leading' } }, '.a')).toBe('leading');
  });
});

describe('setByPath', () => {
  it('sets value on top-level property', () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, 'title', 'Hello');
    expect(obj.title).toBe('Hello');
  });

  it('creates nested objects when path does not exist', () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, 'a.b.c', 'nestedValue');
    expect(obj).toEqual({ a: { b: { c: 'nestedValue' } } });
  });

  it('replaces intermediate null with an object container (line 182)', () => {
    const obj: Record<string, unknown> = { a: null };
    setByPath(obj, 'a.b', 'created');
    expect(obj).toEqual({ a: { b: 'created' } });
  });

  it('replaces intermediate primitive scalar with an object container (line 182)', () => {
    const objNumber: Record<string, unknown> = { a: 123 };
    setByPath(objNumber, 'a.b', 'fromNumber');
    expect(objNumber).toEqual({ a: { b: 'fromNumber' } });

    const objString: Record<string, unknown> = { a: 'stringVal' };
    setByPath(objString, 'a.b', 'fromString');
    expect(objString).toEqual({ a: { b: 'fromString' } });
  });

  it('preserves neighboring properties when setting nested path', () => {
    const obj: Record<string, unknown> = {
      config: {
        existingProp: 'keepMe',
      },
    };
    setByPath(obj, 'config.newProp', 'added');
    expect(obj).toEqual({
      config: {
        existingProp: 'keepMe',
        newProp: 'added',
      },
    });
  });
});

describe('sanitizeObject extended and regression behavior', () => {
  it('handles required and default values when field is missing', () => {
    const input: Record<string, unknown> = { existing: 'val' };
    const out = sanitizeObject(input, {
      existing: true,
      missing: { required: true, default: '<b>Default</b>', stripHTML: true },
    });
    expect(out.existing).toBe('val');
    expect(out.missing).toBe('Default');
  });

  it('handles string[] type', () => {
    const input: Record<string, unknown> = {
      tags: [' <b>one</b> ', 123, null],
    };
    const out = sanitizeObject(input, {
      tags: { type: 'string[]', stripHTML: true },
    });
    expect(out.tags).toEqual(['one', 123, null]);
  });

  it('ignores string[] rules when value is not an array', () => {
    const input: Record<string, unknown> = {
      tags: 'not-an-array',
    };
    const out = sanitizeObject(input, {
      tags: { type: 'string[]', stripHTML: true },
    });
    expect(out.tags).toBe('not-an-array');
  });

  it('handles null object in path without default rule (exercises line 171 empty-result path)', () => {
    const input: Record<string, unknown> = { a: null };
    const out = sanitizeObject(input, { 'a.b': true });
    expect(out.a).toBeNull();
  });

  it('populates default value when intermediate null is encountered with required rule (exercises line 171 -> setByPath)', () => {
    const input: Record<string, unknown> = { a: null };
    const out = sanitizeObject(input, {
      'a.b': { required: true, default: 'fallback', stripHTML: true },
    });
    expect(out.a).toEqual({ b: 'fallback' });
  });

  it('populates default value when intermediate undefined is encountered with required rule', () => {
    const input: Record<string, unknown> = { a: undefined };
    const out = sanitizeObject(input, {
      'a.b.c': { required: true, default: 'deepFallback' },
    });
    expect(out.a).toEqual({ b: { c: 'deepFallback' } });
  });

  it('creates nested objects if missing entirely', () => {
    const input: Record<string, unknown> = {};
    const out = sanitizeObject(input, {
      'profile.details.bio': { required: true, default: 'Hi' },
    });
    expect((out.profile as Record<string, unknown>).details).toEqual({ bio: 'Hi' });
  });

  it('sanitizes existing deep nested string on normal path', () => {
    const input = {
      user: {
        profile: {
          bio: '  <b>Software Engineer</b>  ',
        },
      },
    };
    const out = sanitizeObject(input, {
      'user.profile.bio': { stripHTML: true, trim: true },
    });
    expect(out.user.profile.bio).toBe('Software Engineer');
  });

  it('sanitizes existing deep nested string[] on normal path', () => {
    const input = {
      user: {
        skills: [' <b>TS</b> ', ' <i>Node</i> '],
      },
    };
    const out = sanitizeObject(input, {
      'user.skills': { type: 'string[]', stripHTML: true, trim: true },
    });
    expect(out.user.skills).toEqual(['TS', 'Node']);
  });

  it('supports rule === true shorthand', () => {
    const input = {
      summary: ' <b>Clean</b> ',
    };
    const out = sanitizeObject(input, {
      summary: true,
    });
    expect(out.summary).toBe('Clean');
  });

  it('leaves untouched non-string leaf values when string rule applied', () => {
    const input = {
      count: 100,
      active: true,
    };
    const out = sanitizeObject(input, {
      count: true,
      active: true,
    });
    expect(out.count).toBe(100);
    expect(out.active).toBe(true);
  });
});
