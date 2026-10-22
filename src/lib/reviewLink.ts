/**
 * Sanitizes an internal reviewer-queue link before it is written to an audit
 * log or API response.
 *
 * Security assumptions:
 * - Only relative, single-segment-style internal paths are allowed. Absolute
 *   URLs, scheme/host injection, `..` traversal, and query/fragment junk are
 *   rejected so a caller-controlled value can never forge a link to an
 *   external origin.
 * - The output is constrained to `[A-Za-z0-9/._-]`, which is safe for JSON,
 *   HTML, and URL contexts.
 */
export function sanitizeReviewLink(link: string): string {
  if (typeof link !== 'string' || link.length === 0 || link.length > 512) {
    return '';
  }
  if (!/^\/[A-Za-z0-9/._-]*$/.test(link)) {
    return '';
  }
  if (link.includes('//') || link.includes('..')) {
    return '';
  }
  return link;
}