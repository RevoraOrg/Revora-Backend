import { toCsvField } from './csv';

// Minimal RFC 4180 field parser used only to assert round-trip behaviour in
// tests. Handles quoted fields, doubled quotes, and embedded newlines.
function parseCsvFields(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++; // opening quote
      const chars: string[] = [];
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            chars.push('"');
            i += 2;
          } else {
            i++; // closing quote
            break;
          }
        } else {
          chars.push(line[i]);
          i++;
        }
      }
      fields.push(chars.join(''));
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        i = line.length;
      } else {
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
    if (i < line.length && line[i] === ',') i++;
  }
  return fields;
}

describe('toCsvField', () => {
  it('quotes every field', () => {
    expect(toCsvField('plain')).toBe('"plain"');
    expect(toCsvField('')).toBe('""');
  });

  it('doubles embedded quotes', () => {
    expect(toCsvField('a"b')).toBe('"a""b"');
  });

  it('round-trips a,b"c\\nd through a standard CSV parser as one field', () => {
    const value = 'a,b"c\nd';
    const parsed = parseCsvFields(toCsvField(value));
    expect(parsed).toEqual([value]);
  });

  it('prefixes formula-starting values with an apostrophe', () => {
    expect(toCsvField('=1+1')).toBe('"\'=1+1\'"');
    expect(toCsvField('=HYPERLINK("http://x","click")')).toContain("'=HYPERLINK");
    expect(toCsvField('+100')).toBe('"\'+100\'"');
    expect(toCsvField('-5')).toBe("\"'-5'\"");
    expect(toCsvField('@me')).toBe("\"'@me'\"");
    expect(toCsvField('\ttab')).toBe("\"'\ttab'\"");
    expect(toCsvField('\rreturn')).toBe("\"'\rreturn'\"");
  });

  it('does not prefix values whose first char is not a formula trigger', () => {
    expect(toCsvField('hello')).toBe('"hello"');
    expect(toCsvField('  =1')).toBe('"  =1"');
    expect(toCsvField('=1')).toBe('"\'=1\'"');
  });

  it('handles undefined and null as empty string', () => {
    expect(toCsvField(undefined)).toBe('""');
    expect(toCsvField(null)).toBe('""');
  });

  it('escapes a newline-only value so it stays one field', () => {
    const parsed = parseCsvFields(toCsvField('\n'));
    expect(parsed).toEqual(['\n']);
  });
});
