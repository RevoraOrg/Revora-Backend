import { sanitizeString, sanitizeFields, presets } from './sanitize';

describe('sanitizeString', () => {
  it('strips HTML tags and collapses whitespace', () => {
    const input = ' <b>Hello</b>   <i>world</i>\n<script>alert(1)</script> ';
    const out = sanitizeString(input, { maxLength: 50 });
    expect(out).toBe('Hello world');
  });

  it('preserves newlines when keepNewlines is true', () => {
    const input = 'Line 1 \n\n Line   2\t\t End';
    const out = sanitizeString(input, { keepNewlines: true, maxLength: 200 });
    expect(out).toBe('Line 1\n\n Line 2 End');
  });

  it('removes control characters and null bytes', () => {
    const input = 'Text\u0000\u0007with\u0001controls';
    const out = sanitizeString(input, { maxLength: 100 });
    expect(out).toBe('Textwithcontrols');
  });

  it('enforces max length', () => {
    const input = 'x'.repeat(200);
    const out = sanitizeString(input, { maxLength: 10 });
    expect(out.length).toBe(10);
  });
});

describe('sanitizeFields', () => {
  it('sanitizes simple top-level fields', () => {
    const payload = {
      title: '<h1> My   Title </h1>',
      description: ' A\n\n\n long     text ',
    };
    const clean = sanitizeFields(payload, {
      title: presets.title(),
      description: presets.description(),
    });
    expect(clean.title).toBe('My Title');
    expect(clean.description).toBe('A\n\n long text');
  });

  it('supports dot-notation paths and arrays', () => {
    const payload = {
      profile: { name: '  <em>Alice</em>  ' },
      tags: ['  <b>x</b>  ', ' y  ', '<script>xss()</script>z'],
    };
    const clean = sanitizeFields(payload, {
      'profile.name': presets.title(),
      'tags': presets.stringArray({ maxLength: 5 }),
    });
    expect(clean.profile.name).toBe('Alice');
    expect(clean.tags).toEqual(['x', 'y', 'z']);
  });
});

