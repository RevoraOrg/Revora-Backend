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
    const oldHash = await hashPassword('correct-horse-battery');   // ← await added
    const updatePasswordHash = jest.fn().mockResolvedValue(undefined);

    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({ id: 'u1', password_hash: oldHash }),
      updatePasswordHash,
    });

    const svc = new ChangePasswordService(repo);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'correct-horse-battery',
      newPassword: 'new-secure-pw-123',
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
        password_hash: await hashPassword('real-password'),   // ← await added
      }),
    });

    const svc = new ChangePasswordService(repo);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'wrong-password',
      newPassword: 'new-secure-pw-123',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('WRONG_PASSWORD');
  });

  it('returns USER_NOT_FOUND when repo returns null', async () => {
    const svc = new ChangePasswordService(makeRepo());
    const result = await svc.execute({
      userId: 'ghost',
      currentPassword: 'whatever',
      newPassword: 'new-secure-pw-123',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('USER_NOT_FOUND');
  });

  it('returns VALIDATION_ERROR when newPassword is shorter than 8 chars', async () => {
    const svc = new ChangePasswordService(makeRepo());
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'any-password',
      newPassword: 'short',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR when currentPassword is empty string', async () => {
    const svc = new ChangePasswordService(makeRepo());
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: '',
      newPassword: 'new-secure-pw-123',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('VALIDATION_ERROR');
  });
});