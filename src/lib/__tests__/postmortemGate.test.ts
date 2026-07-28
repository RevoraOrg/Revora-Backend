import {
  checkPostmortemGate,
  hasPostmortemFile,
  isSev1,
  postmortemFilePattern,
  POSTMORTEM_DIR,
  SEV1_LABEL,
  TEMPLATE_FILENAME,
} from '../postmortemGate';

describe('postmortemGate', () => {
  describe('isSev1', () => {
    it('detects the SEV-1 label', () => {
      expect(isSev1(['SEV-1'])).toBe(true);
    });

    it('detects SEV-1 among other labels', () => {
      expect(isSev1(['bug', 'SEV-1', 'backend'])).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isSev1(['sev-1'])).toBe(true);
    });

    it('tolerates surrounding whitespace', () => {
      expect(isSev1([' SEV-1 '])).toBe(true);
    });

    it('returns false when the label is absent', () => {
      expect(isSev1(['bug', 'SEV-2'])).toBe(false);
    });

    it('returns false for an empty label list', () => {
      expect(isSev1([])).toBe(false);
    });

    it('does not match a partial label', () => {
      expect(isSev1(['SEV-11', 'not-SEV-1'])).toBe(false);
    });
  });

  describe('postmortemFilePattern', () => {
    it('matches the bare pr-<number>.md form', () => {
      expect(postmortemFilePattern(481).test(`${POSTMORTEM_DIR}/pr-481.md`)).toBe(true);
    });

    it('matches the pr-<number>-<slug>.md form', () => {
      expect(postmortemFilePattern(481).test(`${POSTMORTEM_DIR}/pr-481-reconciliation-drift.md`)).toBe(true);
    });

    it('does not match a different PR number', () => {
      expect(postmortemFilePattern(481).test(`${POSTMORTEM_DIR}/pr-4810.md`)).toBe(false);
      expect(postmortemFilePattern(481).test(`${POSTMORTEM_DIR}/pr-48.md`)).toBe(false);
    });

    it('does not match files outside the postmortems directory', () => {
      expect(postmortemFilePattern(481).test(`docs/pr-481.md`)).toBe(false);
    });
  });

  describe('hasPostmortemFile', () => {
    it('returns true when a matching file is present', () => {
      expect(hasPostmortemFile(481, [`${POSTMORTEM_DIR}/pr-481.md`])).toBe(true);
    });

    it('returns false when only the template was touched', () => {
      expect(hasPostmortemFile(481, [`${POSTMORTEM_DIR}/${TEMPLATE_FILENAME}`])).toBe(false);
    });

    it('returns false when no postmortem files changed', () => {
      expect(hasPostmortemFile(481, ['src/services/distributionEngine.ts'])).toBe(false);
    });

    it('returns false for an empty change set', () => {
      expect(hasPostmortemFile(481, [])).toBe(false);
    });
  });

  describe('checkPostmortemGate', () => {
    it('fails a SEV-1 PR with no postmortem file', () => {
      const result = checkPostmortemGate({
        prNumber: 481,
        labels: [SEV1_LABEL],
        changedFiles: ['src/services/payoutDriftDetector.ts'],
      });
      expect(result.required).toBe(true);
      expect(result.satisfied).toBe(false);
      expect(result.message).toContain('#481');
    });

    it('passes a SEV-1 PR that includes a matching postmortem file', () => {
      const result = checkPostmortemGate({
        prNumber: 481,
        labels: [SEV1_LABEL],
        changedFiles: [`${POSTMORTEM_DIR}/pr-481-drift.md`],
      });
      expect(result.required).toBe(true);
      expect(result.satisfied).toBe(true);
    });

    it('skips the check when the SEV-1 label is absent (e.g. removed)', () => {
      const result = checkPostmortemGate({
        prNumber: 481,
        labels: [],
        changedFiles: [],
      });
      expect(result.required).toBe(false);
      expect(result.satisfied).toBe(true);
    });

    it('does not credit a postmortem file for a different PR number', () => {
      const result = checkPostmortemGate({
        prNumber: 481,
        labels: [SEV1_LABEL],
        changedFiles: [`${POSTMORTEM_DIR}/pr-999.md`],
      });
      expect(result.required).toBe(true);
      expect(result.satisfied).toBe(false);
    });

    it('does not credit editing only the template', () => {
      const result = checkPostmortemGate({
        prNumber: 481,
        labels: [SEV1_LABEL],
        changedFiles: [`${POSTMORTEM_DIR}/${TEMPLATE_FILENAME}`],
      });
      expect(result.required).toBe(true);
      expect(result.satisfied).toBe(false);
    });
  });
});
