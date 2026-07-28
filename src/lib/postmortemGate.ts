/**
 * Enforces that pull requests labeled SEV-1 include a matching reconciliation
 * postmortem document before they can be merged. See docs/postmortems/_template.md
 * and docs/runbooks/payout-reconciliation.md.
 */

export const SEV1_LABEL = 'SEV-1';
export const POSTMORTEM_DIR = 'docs/postmortems';
export const TEMPLATE_FILENAME = '_template.md';

export interface PostmortemGateInput {
  prNumber: number;
  labels: string[];
  changedFiles: string[];
}

export interface PostmortemGateResult {
  required: boolean;
  satisfied: boolean;
  message: string;
}

/** Matches docs/postmortems/pr-<number>.md or docs/postmortems/pr-<number>-<slug>.md */
export function postmortemFilePattern(prNumber: number): RegExp {
  return new RegExp(`^${POSTMORTEM_DIR}/pr-${prNumber}(-[a-z0-9-]+)?\\.md$`);
}

export function isSev1(labels: string[]): boolean {
  return labels.some((label) => label.trim().toUpperCase() === SEV1_LABEL);
}

export function hasPostmortemFile(prNumber: number, changedFiles: string[]): boolean {
  const templatePath = `${POSTMORTEM_DIR}/${TEMPLATE_FILENAME}`;
  const pattern = postmortemFilePattern(prNumber);
  return changedFiles.some((file) => file !== templatePath && pattern.test(file));
}

export function checkPostmortemGate(input: PostmortemGateInput): PostmortemGateResult {
  const { prNumber, labels, changedFiles } = input;

  if (!isSev1(labels)) {
    return {
      required: false,
      satisfied: true,
      message: 'No SEV-1 label present; postmortem not required.',
    };
  }

  const satisfied = hasPostmortemFile(prNumber, changedFiles);
  return {
    required: true,
    satisfied,
    message: satisfied
      ? `Postmortem file found for PR #${prNumber}.`
      : `PR #${prNumber} is labeled ${SEV1_LABEL} but no matching postmortem file was found in ` +
        `${POSTMORTEM_DIR}/ (expected pr-${prNumber}.md or pr-${prNumber}-<slug>.md, based on ` +
        `${POSTMORTEM_DIR}/${TEMPLATE_FILENAME}).`,
  };
}
