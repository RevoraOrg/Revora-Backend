import {
  checkPostmortemGate,
  hasPostmortemFile,
  isSev1,
  postmortemFilePattern,
  POSTMORTEM_DIR,
  SEV1_LABEL,
  TEMPLATE_FILENAME,
} from '../postmortemGate';

/**
 * Contract/edge suite for the SEV-1 postmortem gate (issue: SEV1_LABEL).
 *
 * `src/lib/__tests__/postmortemGate.test.ts` already covers the happy paths.
 * This suite pins the parts that were left unasserted and are easy to regress
 * silently:
 *  - the exact message contract for all three result branches (CI bots and
 *    reviewers read these strings);
 *  - the anchoring and case-sensitivity of `postmortemFilePattern`;
 *  - the published constant values other tooling imports;
 *  - the shape of the result object.
 */
describe('postmortemGate contract', () => {
  describe('published constants', () => {
    it('exposes the documented SEV-1 label', () => {
      expect(SEV1_LABEL).toBe('SEV-1');
    });

    it('exposes the documented postmortem directory', () => {
      expect(POSTMORTEM_DIR).toBe('docs/postmortems');
    });

    it('exposes the documented template filename', () => {
      expect(TEMPLATE_FILENAME).toBe('_template.md');
    });
  });

  describe('postmortemFilePattern anchoring and case', () => {
    const matches = (prNumber: number, file: string) => postmortemFilePattern(prNumber).test(file);

    it('accepts multi-segment slugs', () => {
      expect(matches(481, `${POSTMORTEM_DIR}/pr-481-a-b-c.md`)).toBe(true);
    });

    it('accepts numeric slugs', () => {
      expect(matches(481, `${POSTMORTEM_DIR}/pr-481-2026-q3.md`)).toBe(true);
    });

    it('rejects a trailing extension after .md', () => {
      expect(matches(481, `${POSTMORTEM_DIR}/pr-481.md.bak`)).toBe(false);
    });

    it('rejects an uppercase .MD extension', () => {
      expect(matches(481, `${POSTMORTEM_DIR}/pr-481.MD`)).toBe(false);
    });

    it('rejects an uppercase slug segment', () => {
      expect(matches(481, `${POSTMORTEM_DIR}/pr-481-Slug.md`)).toBe(false);
    });

    it('rejects an underscore-separated slug', () => {
      expect(matches(481, `${POSTMORTEM_DIR}/pr-481_draft.md`)).toBe(false);
    });

    it('rejects a nested subdirectory', () => {
      expect(matches(481, `${POSTMORTEM_DIR}/sub/pr-481.md`)).toBe(false);
    });

    it('rejects a doc that only embeds the number', () => {
      expect(matches(481, `${POSTMORTEM_DIR}/postmortem-pr-481.md`)).toBe(false);
    });

    it('produces a fresh, stateless pattern per call', () => {
      const first = postmortemFilePattern(481);
      const second = postmortemFilePattern(481);

      // A reused global-flagged regex would carry lastIndex between calls.
      expect(first.test(`${POSTMORTEM_DIR}/pr-481.md`)).toBe(true);
      expect(second.test(`${POSTMORTEM_DIR}/pr-481.md`)).toBe(true);
      expect(first.test(`${POSTMORTEM_DIR}/pr-481.md`)).toBe(true);
    });
  });

  describe('hasPostmortemFile interactions', () => {
    it('still credits the postmortem when the template is edited alongside it', () => {
      expect(
        hasPostmortemFile(481, [
          `${POSTMORTEM_DIR}/${TEMPLATE_FILENAME}`,
          `${POSTMORTEM_DIR}/pr-481-drift.md`,
        ]),
      ).toBe(true);
    });

    it('ignores a postmortem-shaped file outside the configured directory', () => {
      expect(hasPostmortemFile(481, [`docs/pr-481.md`])).toBe(false);
    });
  });

  describe('checkPostmortemGate message contract', () => {
    it('returns the documented "not required" message when the label is absent', () => {
      const result = checkPostmortemGate({ prNumber: 481, labels: [], changedFiles: [] });

      expect(result.message).toBe('No SEV-1 label present; postmortem not required.');
    });

    it('returns the documented "satisfied" message naming the PR', () => {
      const result = checkPostmortemGate({
        prNumber: 481,
        labels: [SEV1_LABEL],
        changedFiles: [`${POSTMORTEM_DIR}/pr-481.md`],
      });

      expect(result.message).toBe('Postmortem file found for PR #481.');
    });

    it('names the PR, the directory, the template and both accepted filenames when unsatisfied', () => {
      const result = checkPostmortemGate({
        prNumber: 481,
        labels: [SEV1_LABEL],
        changedFiles: [],
      });

      expect(result.message).toContain('PR #481');
      expect(result.message).toContain(SEV1_LABEL);
      expect(result.message).toContain(POSTMORTEM_DIR);
      expect(result.message).toContain(`${POSTMORTEM_DIR}/${TEMPLATE_FILENAME}`);
      expect(result.message).toContain(`pr-481.md`);
      expect(result.message).toContain(`pr-481-<slug>.md`);
    });

    it('recognises a mixed-case, whitespace-padded label end to end', () => {
      const result = checkPostmortemGate({
        prNumber: 481,
        labels: ['backend', ' sev-1 '],
        changedFiles: [],
      });

      expect(result.required).toBe(true);
      expect(result.satisfied).toBe(false);
    });

    it('returns exactly the declared result shape', () => {
      const result = checkPostmortemGate({ prNumber: 481, labels: [], changedFiles: [] });

      expect(Object.keys(result).sort()).toEqual(['message', 'required', 'satisfied']);
      expect(typeof result.message).toBe('string');
      expect(typeof result.required).toBe('boolean');
      expect(typeof result.satisfied).toBe('boolean');
    });
  });

  describe('isSev1 constants', () => {
    it('matches the exported constant verbatim', () => {
      expect(isSev1([SEV1_LABEL])).toBe(true);
    });

    it('matches a lowercase form of the exported constant', () => {
      expect(isSev1([SEV1_LABEL.toLowerCase()])).toBe(true);
    });

    it('tolerates repeated and surrounding labels', () => {
      expect(isSev1(['bug', SEV1_LABEL, SEV1_LABEL, 'backend'])).toBe(true);
    });
  });
});
