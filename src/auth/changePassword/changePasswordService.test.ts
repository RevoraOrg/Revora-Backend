import { ChangePasswordService, ChangePasswordError } from './changePasswordService';
import { UserRepository, User } from '../../db/repositories/userRepository';
import { SessionRepository } from '../../db/repositories/sessionRepository';
import * as passwordUtils from '../../utils/password';

// ── mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../db/repositories/userRepository');
jest.mock('../../db/repositories/sessionRepository');
jest.mock('../../utils/password');

const MockedRepo = UserRepository as jest.MockedClass<typeof UserRepository>;
const mockedCompare = passwordUtils.comparePassword as jest.MockedFunction<
  typeof passwordUtils.comparePassword
>;
const MockedSessionRepo = SessionRepository as jest.MockedClass<
  typeof SessionRepository
>;
const mockedHash = passwordUtils.hashPassword as jest.MockedFunction<
  typeof passwordUtils.hashPassword
>;

// ── fixtures ───────────────────────────────────────────────────────────────────

const mockUser: User = {
  id: 'user-123',
  email: 'alice@example.com',
  password_hash: 'salt:hash',
  created_at: new Date(),
  updated_at: new Date(),
};

// ── tests ──────────────────────────────────────────────────────────────────────

describe('ChangePasswordService', () => {
  let service: ChangePasswordService;
  let mockRepo: jest.Mocked<UserRepository>;
  let mockSessionRepo: jest.Mocked<SessionRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRepo = new MockedRepo({} as any) as jest.Mocked<UserRepository>;
    mockSessionRepo = new MockedSessionRepo({} as any) as jest.Mocked<SessionRepository>;
    service = new ChangePasswordService(mockRepo, mockSessionRepo);
  });

  it('throws 404 when user is not found', async () => {
    mockRepo.findById.mockResolvedValueOnce(null);

    await expect(
      service.changePassword('user-123', 'session-abc', 'old', 'newPassword1')
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'User not found',
    });

    expect(mockRepo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('throws 401 when currentPassword is incorrect', async () => {
    mockRepo.findById.mockResolvedValueOnce(mockUser);
    mockedCompare.mockResolvedValueOnce(false);

    await expect(
      service.changePassword('user-123', 'session-abc', 'wrongpass', 'newPassword1')
    ).rejects.toMatchObject({
      statusCode: 401,
      message: 'Current password is incorrect',
    });

    expect(mockedCompare).toHaveBeenCalledWith('wrongpass', mockUser.password_hash);
    expect(mockRepo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('hashes the new password and updates it when current password is correct', async () => {
    mockRepo.findById.mockResolvedValueOnce(mockUser);
    mockedCompare.mockResolvedValueOnce(true);
    mockedHash.mockResolvedValueOnce('newsalt:newhash');
    mockRepo.updatePasswordHash.mockResolvedValueOnce(undefined);

    await service.changePassword('user-123', 'session-abc', 'correctpass', 'newPassword1');

    expect(mockedHash).toHaveBeenCalledWith('newPassword1');
    expect(mockRepo.updatePasswordHash).toHaveBeenCalledWith('user-123', 'newsalt:newhash');
    expect(mockSessionRepo.deleteAllSessionsByUserId).toHaveBeenCalledWith('user-123');
  });

  it('throws ChangePasswordError instance (not generic Error)', async () => {
    mockRepo.findById.mockResolvedValueOnce(null);

    const err = await service
      .changePassword('user-123', 'session-abc', 'old', 'new12345')
      .catch((e) => e);

    expect(err).toBeInstanceOf(ChangePasswordError);
  });
});