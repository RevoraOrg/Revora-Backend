import { ChangePasswordService, ChangePasswordUserRepo } from './changePasswordService';
import { SessionRepository } from '../../db/repositories/sessionRepository';
import { hashPassword } from '../../utils/password';
import { PoolClient } from 'pg';

function makeRepo(overrides: Partial<ChangePasswordUserRepo> = {}): ChangePasswordUserRepo {
  return {
    findUserById: jest.fn().mockResolvedValue(null),
    updatePasswordHash: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Minimal fake pg client used by withTransaction. */
function makeClient(): PoolClient {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
    connect: jest.fn(),
  } as unknown as PoolClient;
}

/** Fake Pool whose connect() returns the fake client. */
function makeDb(): { pool: any; client: PoolClient } {
  const client = makeClient();
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
    on: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
  };
  return { pool, client };
}

function makeSessionRepo(overrides: Partial<SessionRepository> = {}): SessionRepository {
  return {
    deleteAllSessionsByUserId: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SessionRepository;
}

describe('ChangePasswordService', () => {
  it('returns ok:true and calls updatePasswordHash with a NEW hash on valid credentials', async () => {
    const { pool } = makeDb();
    const oldHash = await hashPassword('CorrectHorse159!');
    const updatePasswordHash = jest.fn().mockResolvedValue(undefined);

    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({ id: 'u1', password_hash: oldHash }),
      updatePasswordHash,
    });
    const sessionRepo = makeSessionRepo();

    const svc = new ChangePasswordService(repo, sessionRepo, pool);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'CorrectHorse159!',
      newPassword: 'NewSecurePw481!',
    });

    expect(result).toEqual({ ok: true });
    expect(updatePasswordHash).toHaveBeenCalledWith('u1', expect.any(String));

    const [, newHash] = (updatePasswordHash.mock.calls[0] as [string, string]);
    expect(newHash).not.toBe(oldHash);
    expect(sessionRepo.deleteAllSessionsByUserId).toHaveBeenCalledWith('u1', expect.anything());
  });

  it('returns WRONG_PASSWORD when current password does not match', async () => {
    const { pool } = makeDb();
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('RealPassword159!'),
      }),
    });
    const sessionRepo = makeSessionRepo();

    const svc = new ChangePasswordService(repo, sessionRepo, pool);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'WrongPassword159!',
      newPassword: 'NewSecurePw481!',
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      reason: 'WRONG_PASSWORD',
      message: 'Current password is incorrect.',
    });
    expect(sessionRepo.deleteAllSessionsByUserId).not.toHaveBeenCalled();
  });

  it('returns USER_NOT_FOUND when repo returns null', async () => {
    const { pool } = makeDb();
    const svc = new ChangePasswordService(makeRepo(), makeSessionRepo(), pool);
    const result = await svc.execute({
      userId: 'ghost',
      currentPassword: 'SomePass159!',
      newPassword: 'NewSecurePw481!',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'USER_NOT_FOUND',
      message: 'User not found.',
    });
  });

  it('returns VALIDATION_ERROR when newPassword is shorter than 12 chars', async () => {
    const { pool } = makeDb();
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('CurrentPass159!'),
      }),
    });
    const svc = new ChangePasswordService(repo, makeSessionRepo(), pool);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'CurrentPass159!',
      newPassword: 'short',
    });

    expect(result).toMatchObject({ ok: false, reason: 'VALIDATION_ERROR' });
    // Validation happens before any DB interaction.
    expect(repo.findUserById).not.toHaveBeenCalled();
  });

  it('returns VALIDATION_ERROR when newPassword does not meet strength requirements', async () => {
    const { pool } = makeDb();
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue({
        id: 'u1',
        password_hash: await hashPassword('CurrentPass159!'),
      }),
    });
    const svc = new ChangePasswordService(repo, makeSessionRepo(), pool);
    const result = await svc.execute({
      userId: 'u1',
      currentPassword: 'CurrentPass159!',
      newPassword: 'weakpassword',
    });

    expect(result).toMatchObject({ ok: false, reason: 'VALIDATION_ERROR' });
  });
});