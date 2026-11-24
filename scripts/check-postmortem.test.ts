import { run } from './check-postmortem';

describe('scripts/check-postmortem run()', () => {
  const ORIGINAL_ENV = process.env;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PR_NUMBER;
    delete process.env.PR_LABELS;
    delete process.env.PR_CHANGED_FILES;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it('exits 1 when PR_NUMBER is missing', () => {
    run();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('PR_NUMBER'));
  });

  it('exits 1 when PR_NUMBER is not a positive integer', () => {
    process.env.PR_NUMBER = 'abc';
    run();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 0 when no SEV-1 label is present, even with invalid JSON labels', () => {
    process.env.PR_NUMBER = '42';
    process.env.PR_LABELS = '{not json';
    process.env.PR_CHANGED_FILES = '[]';
    run();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('treats invalid JSON in env vars as empty arrays', () => {
    process.env.PR_NUMBER = '7';
    process.env.PR_LABELS = '["SEV-1"';
    process.env.PR_CHANGED_FILES = 'oops';
    run();
    // Labels parsed as [] -> not SEV-1 -> gate passes
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('treats non-array JSON as empty arrays', () => {
    process.env.PR_NUMBER = '7';
    process.env.PR_LABELS = '{"0":"SEV-1"}';
    process.env.PR_CHANGED_FILES = '"docs/postmortems/pr-7.md"';
    run();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('filters non-string entries out of JSON arrays', () => {
    process.env.PR_NUMBER = '9';
    process.env.PR_LABELS = JSON.stringify([42, null, 'SEV-1']);
    process.env.PR_CHANGED_FILES = JSON.stringify([{ path: 'x' }, 'src/a.ts']);
    run();
    // SEV-1 survives filtering, no postmortem file -> gate fails
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 0 when SEV-1 is labelled and a matching postmortem file is changed', () => {
    process.env.PR_NUMBER = '15';
    process.env.PR_LABELS = JSON.stringify(['SEV-1']);
    process.env.PR_CHANGED_FILES = JSON.stringify(['docs/postmortems/pr-15-outage.md']);
    run();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Postmortem file found'));
  });

  it('exits 1 when SEV-1 is labelled and no postmortem file is changed', () => {
    process.env.PR_NUMBER = '15';
    process.env.PR_LABELS = JSON.stringify(['SEV-1']);
    process.env.PR_CHANGED_FILES = JSON.stringify(['src/index.ts']);
    run();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('docs/postmortems/pr-15-<slug>.md'));
  });
});
