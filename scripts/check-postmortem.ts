/**
 * CI entry point for the postmortem-required gate (see .github/workflows/postmortem-required.yml).
 * Pure decision logic lives in src/lib/postmortemGate.ts (unit tested there); this file only
 * parses the PR metadata the workflow fetches via the read-only GitHub API and reports pass/fail.
 */
import { checkPostmortemGate } from '../src/lib/postmortemGate';

function parseJsonStringArray(envVarName: string): string[] {
  const raw = process.env[envVarName];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === 'string');
}

export function run(): void {
  const prNumber = Number(process.env.PR_NUMBER);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('PR_NUMBER env var must be set to a positive integer.');
    process.exit(1);
    return;
  }

  const labels = parseJsonStringArray('PR_LABELS');
  const changedFiles = parseJsonStringArray('PR_CHANGED_FILES');

  const result = checkPostmortemGate({ prNumber, labels, changedFiles });
  console.log(result.message);

  if (result.required && !result.satisfied) {
    console.error(
      `Add docs/postmortems/pr-${prNumber}-<slug>.md before merging (see docs/postmortems/_template.md).`
    );
    process.exit(1);
    return;
  }

  process.exit(0);
}

if (require.main === module) {
  run();
}
