/**
 * IANA timezone allowlist for per-offering distribution scheduling.
 *
 * Security: only timezones in this set are accepted for storage.
 * Adding or removing entries requires a code review.
 */
export const ALLOWED_TIMEZONES: ReadonlySet<string> = new Set([
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Argentina/Buenos_Aires',
  'America/Bogota',
  'America/Caracas',
  'America/Chicago',
  'America/Denver',
  'America/Halifax',
  'America/Lima',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/St_Johns',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Bangkok',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Ho_Chi_Minh',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Kolkata',
  'Asia/Kuala_Lumpur',
  'Asia/Manila',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Brussels',
  'Europe/Copenhagen',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Oslo',
  'Europe/Paris',
  'Europe/Prague',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Vienna',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Fiji',
  'Pacific/Honolulu',
  'Pacific/Samoa',
  'UTC',
]);

const UTC_ID = 'UTC';

export function isValidTimezone(tz: string): boolean {
  return ALLOWED_TIMEZONES.has(tz);
}

export function assertValidTimezone(tz: string, label = 'timezone'): void {
  if (!isValidTimezone(tz)) {
    throw new Error(`Invalid ${label}: "${tz}" is not in the allowed timezone list`);
  }
}

export function normalizeTimezone(tz: string): string {
  if (tz === 'Etc/UTC' || tz === 'Etc/GMT' || tz === 'GMT' || tz === 'Z') {
    return UTC_ID;
  }
  return tz;
}
