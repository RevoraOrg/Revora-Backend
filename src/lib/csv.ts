/**
 * CSV field escaping helper implementing RFC 4180 quoting plus OWASP
 * formula-injection guard.
 *
 * Every field is wrapped in double quotes. Embedded double quotes are doubled.
 * Values whose first character is one of `=`, `+`, `-`, `@`, tab (`\t`) or
 * carriage return (`\r`) are prefixed with a single apostrophe so spreadsheet
 * applications (Excel, Google Sheets, LibreOffice) treat them as literal text
 * rather than executing them as formulas.
 *
 * @param value - Raw field value (undefined/null treated as empty string).
 * @returns An RFC 4180-quoted, formula-guarded CSV field.
 */
export function toCsvField(value: unknown): string {
  const raw = value === undefined || value === null ? '' : String(value);

  const needsFormulaGuard =
    raw.length > 0 &&
    ('=+-@\t\r'.includes(raw[0]) || raw.startsWith('\n'));

  const escaped = needsFormulaGuard ? `'${raw}` : raw;
  const quoted = `"${escaped.replace(/"/g, '""')}"`;

  return quoted;
}
