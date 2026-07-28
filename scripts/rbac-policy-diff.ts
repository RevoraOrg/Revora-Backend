/**
 * CI helper: compute RBAC policy matrix diff between PR head and base branch.
 *
 * Reads the canonical `enabledPermissions` block from `src/security/types.ts`
 * on both the PR head and the base branch, serializes both to deterministic
 * fingerprints, and prints the resulting added/removed grants.
 *
 * Outputs:
 *   - `has_diff=true|false` to GITHUB_OUTPUT (or stdout) for the workflow step.
 *   - Human-readable markdown diff to stdout for PR comments and logs.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  extractPolicyFromSource,
  computePolicyDiff,
  formatPolicyDiff,
  serializePolicy,
  PolicyMatrix,
  PolicyDiff,
} from '../src/security/rbacPolicySerializer';

const POLICY_FILE = path.join(process.cwd(), 'src/security/types.ts');

function readHeadMatrix(): PolicyMatrix {
  return extractPolicyFromSource(fs.readFileSync(POLICY_FILE, 'utf8'));
}

function readBaseMatrix(baseRef: string): PolicyMatrix {
  const baseSource = execSync(`git show ${baseRef}:src/security/types.ts`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return extractPolicyFromSource(baseSource);
}

function writeOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

function main(): void {
  const baseRef = process.env.PR_BASE_REF || process.env.GITHUB_BASE_REF;
  if (!baseRef) {
    console.error('PR_BASE_REF / GITHUB_BASE_REF is required');
    process.exit(1);
  }

  const baseMatrix = readBaseMatrix(baseRef);
  const headMatrix = readHeadMatrix();

  const diff = computePolicyDiff(baseMatrix, headMatrix);
  const hasDiff = diff.added.length > 0 || diff.removed.length > 0;

  const baseFingerprint = serializePolicy(baseMatrix);
  const headFingerprint = serializePolicy(headMatrix);

  console.log('## RBAC Policy Matrix Diff');
  console.log('');
  console.log(`Base fingerprint: \`${baseFingerprint}\``);
  console.log(`Head fingerprint: \`${headFingerprint}\``);
  console.log('');
  console.log(formatPolicyDiff(diff));

  writeOutput('has_diff', String(hasDiff));
}

main();
