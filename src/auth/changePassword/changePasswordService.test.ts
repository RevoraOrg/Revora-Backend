import { ChangePasswordService, ChangePasswordUserRepo } from './changePasswordService';
import { hashPassword } from '../../utils/password';   // ← was ../../lib/hash

function makeRepo(overrides: Partial<ChangePasswordUserRepo> = {}): ChangePasswordUserRepo {
  return {
    findUserById: jest.fn().mockResolvedValue(null),
    updatePasswordHash: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ChangePasswordService', () => {
  it('returns ok:true and calls updatePasswordHash with a NEW hash on valid credentials', async () => {
    const oldHash = await hashPassword('CorrectHorse159!');   // Strong password - no sequential digits
    const updatePasswordHash = jest.fn().mockResolvedValue(undefined);

    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({ id: 'u1', password_hash: oldHash }),
      updatePasswordHash,
    });

    const svc = new ChangePasswordService(repo);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'CorrectHorse159!',
      newPassword: 'NewSecurePw481!',
    });

    expect(result.ok).toBe(true);
    expect(updatePasswordHash).toHaveBeenCalledWith('u1', expect.any(String));

    const [, newHash] = (updatePasswordHash.mock.calls[0] as [string, string]);
    expect(newHash).not.toBe(oldHash);
  });

  it('returns WRONG_PASSWORD when current password does not match', async () => {
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('RealPassword159!'),   // Strong password
      }),
    });

    const svc = new ChangePasswordService(repo);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'WrongPassword159!',
      newPassword: 'NewSecurePw481!',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('WRONG_PASSWORD');
  });

  it('returns USER_NOT_FOUND when repo returns null', async () => {
    const svc = new ChangePasswordService(makeRepo());
    const result = await svc.execute({
      userId: 'ghost',
      currentPassword: 'SomePass159!',
      newPassword: 'NewSecurePw481!',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('USER_NOT_FOUND');
  });

  it('returns VALIDATION_ERROR when newPassword is shorter than 12 chars', async () => {
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('CurrentPass159!'),
      }),
    });
    const svc = new ChangePasswordService(repo);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'CurrentPass159!',
      newPassword: 'short',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR when newPassword does not meet strength requirements', async () => {
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('CurrentPass159!'),
      }),
    });
    const svc = new ChangePasswordService(repo);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'CurrentPass159!',
      newPassword: 'weakpassword',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('VALIDATION_ERROR');
      expect(result.message).toContain('does not meet strength requirements');
    }
  });
});