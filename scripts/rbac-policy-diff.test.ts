import { execSync } from 'child_process';
import fs from 'fs';

import { main } from './rbac-policy-diff';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

jest.mock('fs', () => ({
  __esModule: true,
  default: {
    readFileSync: jest.fn(),
    appendFileSync: jest.fn(),
  },
  readFileSync: jest.fn(),
  appendFileSync: jest.fn(),
}));

describe('rbac-policy-diff', () => {
  const originalPrBaseRef = process.env.PR_BASE_REF;
  const originalGithubBaseRef = process.env.GITHUB_BASE_REF;
  const originalGithubOutput = process.env.GITHUB_OUTPUT;
  const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  const sourceFor = (permissions: string[]): string => `
    export const DEFAULT_SECURITY_CONFIG = {
      enabledPermissions: {
        'member': [${permissions.map((permission) => `'${permission}'`).join(', ')}]
      }
    };
  `;

  function runDiff(basePermissions: string[], headPermissions: string[]): void {
    (execSync as jest.Mock).mockReturnValue(sourceFor(basePermissions));
    (fs.readFileSync as jest.Mock).mockReturnValue(sourceFor(headPermissions));
    main();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PR_BASE_REF = 'main';
    delete process.env.GITHUB_BASE_REF;
    process.env.GITHUB_OUTPUT = '/tmp/github-output';
  });

  afterAll(() => {
    if (originalPrBaseRef === undefined) {
      delete process.env.PR_BASE_REF;
    } else {
      process.env.PR_BASE_REF = originalPrBaseRef;
    }

    if (originalGithubBaseRef === undefined) {
      delete process.env.GITHUB_BASE_REF;
    } else {
      process.env.GITHUB_BASE_REF = originalGithubBaseRef;
    }

    if (originalGithubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = originalGithubOutput;
    }

    consoleLog.mockRestore();
  });

  it('classifies an unchanged policy matrix as no diff', () => {
    runDiff(['read'], ['read']);

    expect(consoleLog).toHaveBeenCalledWith(
      'No RBAC permission changes detected.',
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/github-output',
      'has_diff=false\n',
    );
  });

  it('classifies an added permission and marks the output as changed', () => {
    runDiff(['read'], ['read', 'write']);

    expect(consoleLog).toHaveBeenCalledWith('### Added Grants\n- **member**: `write`');
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/github-output',
      'has_diff=true\n',
    );
  });

  it('classifies a removed permission and marks the output as changed', () => {
    runDiff(['read', 'write'], ['read']);

    expect(consoleLog).toHaveBeenCalledWith('### Removed Grants\n- **member**: `write`');
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/github-output',
      'has_diff=true\n',
    );
  });

  it('reads the base policy from the configured ref and appends the workflow output', () => {
    runDiff(['read'], ['read']);

    expect(execSync).toHaveBeenCalledWith(
      'git show main:src/security/types.ts',
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/github-output',
      'has_diff=false\n',
    );
  });
});
