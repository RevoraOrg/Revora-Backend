import { ChangePasswordService, ChangePasswordUserRepo } from './changePasswordService';
import { hashPassword } from '../../utils/password';
import { AppError, ErrorCode } from '../../lib/errors';

function makeRepo(overrides: Partial<ChangePasswordUserRepo> = {}): ChangePasswordUserRepo {
  return {
    findUserById: jest.fn().mockResolvedValue(null),
    updatePasswordHash: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ChangePasswordService', () => {
  it('returns ok:true and calls updatePasswordHash with a NEW hash on valid credentials', async () => {
    const oldHash = await hashPassword('CorrectHorse159!');
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

  it('throws BAD_REQUEST when current password does not match', async () => {
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('RealPassword159!'),
      }),
    });

    const svc = new ChangePasswordService(repo);
    const promise = svc.execute({
      userId: 'u1',
      currentPassword: 'WrongPassword159!',
      newPassword: 'NewSecurePw481!',
    });

    await expect(promise).rejects.toThrow(AppError);
    await expect(promise).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      message: 'Current password is incorrect.',
    });
  });

  it('throws NOT_FOUND when repo returns null', async () => {
    const svc = new ChangePasswordService(makeRepo());
    const promise = svc.execute({
      userId: 'ghost',
      currentPassword: 'SomePass159!',
      newPassword: 'NewSecurePw481!',
    });

    await expect(promise).rejects.toThrow(AppError);
    await expect(promise).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
      message: 'User not found.',
    });
  });

  it('throws VALIDATION_ERROR when newPassword is shorter than 12 chars', async () => {
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('CurrentPass159!'),
      }),
    });
    const svc = new ChangePasswordService(repo);
    const promise = svc.execute({
      userId: 'u1',
      currentPassword: 'CurrentPass159!',
      newPassword: 'short',
    });

    await expect(promise).rejects.toThrow(AppError);
    await expect(promise).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('throws VALIDATION_ERROR when newPassword does not meet strength requirements', async () => {
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('CurrentPass159!'),
      }),
    });
    const svc = new ChangePasswordService(repo);
    const promise = svc.execute({
      userId: 'u1',
      currentPassword: 'CurrentPass159!',
      newPassword: 'weakpassword',
    });

    await expect(promise).rejects.toThrow(AppError);
    await expect(promise).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    
    try {
      await promise;
    } catch (err: any) {
      expect(err.details).toBeDefined();
      expect(err.details.errors).toBeDefined();
      expect(err.details.errors.length).toBeGreaterThan(0);
    }
  });
});
