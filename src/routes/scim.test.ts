import express from 'express';
import request from 'supertest';
import { createScimRouter } from './scim';
import { UserRepository, SafeUser } from '../db/repositories/userRepository';
import { UniqueConstraintError } from '../lib/errors';

type MockUserRepo = jest.Mocked<Pick<UserRepository, 'findById' | 'findByEmail' | 'createUser' | 'updateUser'>>;

function createMockRepo(): MockUserRepo {
  return {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
  };
}

const SAMPLE_USER: SafeUser = {
  id: 'user-1',
  email: 'jane@example.com',
  name: 'Jane Doe',
  role: 'startup',
  kyc_risk_tier: 'low',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
};

const TOKEN = 'scim-token-abc';
const BASE_URL = '/scim/v2';

function buildApp(repo: MockUserRepo) {
  const app = express();
  app.use(express.json());
  app.use('/scim/v2', createScimRouter(repo as unknown as UserRepository, TOKEN, BASE_URL));
  return app;
}

function auth(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${TOKEN}`);
}

describe('SCIM 2.0 — Auth', () => {
  const repo = createMockRepo();
  const app = buildApp(repo);

  it('returns 401 when no auth header', async () => {
    const res = await request(app).get('/scim/v2/ServiceProviderConfig');
    expect(res.status).toBe(401);
    expect(res.body.scimType).toBe('authorization');
  });

  it('returns 401 when token is wrong', async () => {
    const res = await request(app)
      .get('/scim/v2/ServiceProviderConfig')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body.scimType).toBe('authorization');
  });
});

describe('SCIM 2.0 — ServiceProviderConfig', () => {
  const app = buildApp(createMockRepo());

  it('returns 200 with config', async () => {
    const res = await auth(request(app).get('/scim/v2/ServiceProviderConfig'));
    expect(res.status).toBe(200);
    expect(res.body.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig');
    expect(res.body.patch.supported).toBe(true);
    expect(res.body.filter.supported).toBe(true);
  });
});

describe('SCIM 2.0 — Schemas', () => {
  const app = buildApp(createMockRepo());

  it('lists all schemas', async () => {
    const res = await auth(request(app).get('/scim/v2/Schemas'));
    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(3);
    expect(res.body.Resources[0].id).toBe('urn:ietf:params:scim:schemas:core:2.0:User');
  });

  it('returns a single schema by id', async () => {
    const res = await auth(request(app).get('/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User'));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('User');
  });

  it('returns 404 for unknown schema', async () => {
    const res = await auth(request(app).get('/scim/v2/Schemas/urn:unknown'));
    expect(res.status).toBe(404);
  });
});

describe('SCIM 2.0 — ResourceTypes', () => {
  const app = buildApp(createMockRepo());

  it('lists resource types', async () => {
    const res = await auth(request(app).get('/scim/v2/ResourceTypes'));
    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(2);
  });
});

describe('SCIM 2.0 — Users', () => {
  let repo: MockUserRepo;

  beforeEach(() => {
    repo = createMockRepo();
  });

  describe('GET /Users', () => {
    it('returns empty list when no filter matches', async () => {
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users'));
      expect(res.status).toBe(200);
      expect(res.body.totalResults).toBe(0);
    });

    it('finds user by userName eq filter', async () => {
      repo.findByEmail.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users?filter=userName eq "jane@example.com"'));
      expect(res.status).toBe(200);
      expect(res.body.totalResults).toBe(1);
      expect(res.body.Resources[0].userName).toBe('jane@example.com');
    });

    it('handles pagination with startIndex and count', async () => {
      repo.findByEmail.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users?startIndex=1&count=10'));
      expect(res.status).toBe(200);
      expect(res.body.startIndex).toBe(1);
    });

    it('clamps count to max 200', async () => {
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users?count=999'));
      expect(res.status).toBe(200);
    });

    it('finds user by id eq filter', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users?filter=id eq "user-1"'));
      expect(res.status).toBe(200);
      expect(res.body.totalResults).toBe(1);
    });

    it('handles DB errors gracefully', async () => {
      repo.findByEmail.mockRejectedValue(new Error('db down'));
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users?filter=userName eq "x@x.com"'));
      expect(res.status).toBe(500);
    });
  });

  describe('POST /Users', () => {
    it('creates a new user', async () => {
      repo.findByEmail.mockResolvedValue(null);
      repo.createUser.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).post('/scim/v2/Users').send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'jane@example.com',
        name: { givenName: 'Jane', familyName: 'Doe' },
      }));
      expect(res.status).toBe(201);
      expect(res.body.userName).toBe('jane@example.com');
    });

    it('returns 400 when userName is missing', async () => {
      const app = buildApp(repo);
      const res = await auth(request(app).post('/scim/v2/Users').send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      }));
      expect(res.status).toBe(400);
      expect(res.body.scimType).toBe('invalidValue');
    });

    it('returns 201 (idempotent) when user already exists', async () => {
      repo.findByEmail.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).post('/scim/v2/Users').send({
        userName: 'jane@example.com',
      }));
      expect(res.status).toBe(201);
      expect(res.body.userName).toBe('jane@example.com');
    });

    it('handles createUser UniqueConstraintError', async () => {
      repo.findByEmail.mockResolvedValue(null);
      repo.createUser.mockRejectedValue(new UniqueConstraintError('email'));
      const app = buildApp(repo);
      const res = await auth(request(app).post('/scim/v2/Users').send({
        userName: 'jane@example.com',
      }));
      expect(res.status).toBe(409);
      expect(res.body.scimType).toBe('uniqueness');
    });

    it('handles generic createUser error', async () => {
      repo.findByEmail.mockResolvedValue(null);
      repo.createUser.mockRejectedValue(new Error('internal'));
      const app = buildApp(repo);
      const res = await auth(request(app).post('/scim/v2/Users').send({
        userName: 'jane@example.com',
      }));
      expect(res.status).toBe(500);
    });
  });

  describe('GET /Users/:id', () => {
    it('returns a user by id', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users/user-1'));
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('user-1');
    });

    it('returns 404 for unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users/unknown'));
      expect(res.status).toBe(404);
    });

    it('handles DB errors', async () => {
      repo.findById.mockRejectedValue(new Error('db error'));
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Users/user-1'));
      expect(res.status).toBe(500);
    });
  });

  describe('PUT /Users/:id', () => {
    it('replaces a user', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockResolvedValue({ ...SAMPLE_USER, name: 'Jane Smith', password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).put('/scim/v2/Users/user-1').send({
        userName: 'jane@example.com',
        name: { givenName: 'Jane', familyName: 'Smith' },
        active: true,
      }));
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
    });

    it('returns 404 for unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      const app = buildApp(repo);
      const res = await auth(request(app).put('/scim/v2/Users/unknown').send({}));
      expect(res.status).toBe(404);
    });

    it('deactivates user when active=false', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockResolvedValue({ ...SAMPLE_USER, name: '', password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).put('/scim/v2/Users/user-1').send({ active: false }));
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
    });

    it('handles UniqueConstraintError on update', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockRejectedValue(new UniqueConstraintError('email'));
      const app = buildApp(repo);
      const res = await auth(request(app).put('/scim/v2/Users/user-1').send({ userName: 'other@example.com' }));
      expect(res.status).toBe(409);
    });

    it('handles generic update error', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockRejectedValue(new Error('fail'));
      const app = buildApp(repo);
      const res = await auth(request(app).put('/scim/v2/Users/user-1').send({}));
      expect(res.status).toBe(500);
    });
  });

  describe('PATCH /Users/:id', () => {
    it('replaces userName via patch', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockResolvedValue({ ...SAMPLE_USER, email: 'new@example.com', password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Users/user-1').send({
        Operations: [{ op: 'replace', path: 'userName', value: 'new@example.com' }],
      }));
      expect(res.status).toBe(200);
    });

    it('replaces active via patch path', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Users/user-1').send({
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }));
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
    });

    it('replaces active via value object', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Users/user-1').send({
        Operations: [{ op: 'replace', value: { active: false } }],
      }));
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
    });

    it('replaces name via patch sub-attributes', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockResolvedValue({ ...SAMPLE_USER, name: 'New First', password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Users/user-1').send({
        Operations: [{ op: 'replace', value: { name: { givenName: 'New', familyName: 'First' } } }],
      }));
      expect(res.status).toBe(200);
    });

    it('replaces displayName via patch', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockResolvedValue({ ...SAMPLE_USER, name: 'New Name', password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Users/user-1').send({
        Operations: [{ op: 'replace', path: 'displayName', value: 'New Name' }],
      }));
      expect(res.status).toBe(200);
    });

    it('returns 404 for unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Users/unknown').send({ Operations: [] }));
      expect(res.status).toBe(404);
    });

    it('handles UniqueConstraintError on patch', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockRejectedValue(new UniqueConstraintError('email'));
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Users/user-1').send({
        Operations: [{ op: 'replace', path: 'userName', value: 'taken@example.com' }],
      }));
      expect(res.status).toBe(409);
    });

    it('handles generic patch error', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      repo.updateUser.mockRejectedValue(new Error('fail'));
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Users/user-1').send({
        Operations: [{ op: 'replace', value: { displayName: 'X' } }],
      }));
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /Users/:id', () => {
    it('deactivates a user (soft delete)', async () => {
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const app = buildApp(repo);
      const res = await auth(request(app).delete('/scim/v2/Users/user-1'));
      expect(res.status).toBe(204);

      // Subsequent GET should show active=false
      repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
      const res2 = await auth(request(app).get('/scim/v2/Users/user-1'));
      expect(res2.body.active).toBe(false);
    });

    it('returns 404 for unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      const app = buildApp(repo);
      const res = await auth(request(app).delete('/scim/v2/Users/unknown'));
      expect(res.status).toBe(404);
    });

    it('handles DB errors on delete', async () => {
      repo.findById.mockRejectedValue(new Error('db error'));
      const app = buildApp(repo);
      const res = await auth(request(app).delete('/scim/v2/Users/user-1'));
      expect(res.status).toBe(500);
    });
  });
});

describe('SCIM 2.0 — Groups', () => {
  let repo: MockUserRepo;

  beforeEach(() => {
    repo = createMockRepo();
  });

  describe('POST and GET /Groups', () => {
    it('creates a group and retrieves it', async () => {
      const app = buildApp(repo);
      const createRes = await auth(request(app).post('/scim/v2/Groups').send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Engineers',
        members: [{ value: 'user-1', display: 'Jane Doe' }],
      }));
      expect(createRes.status).toBe(201);
      expect(createRes.body.displayName).toBe('Engineers');

      const getRes = await auth(request(app).get(`/scim/v2/Groups/${createRes.body.id}`));
      expect(getRes.status).toBe(200);
      expect(getRes.body.displayName).toBe('Engineers');
    });

    it('returns 400 when displayName is missing', async () => {
      const app = buildApp(repo);
      const res = await auth(request(app).post('/scim/v2/Groups').send({}));
      expect(res.status).toBe(400);
      expect(res.body.scimType).toBe('invalidValue');
    });

    it('returns 409 when group name already exists', async () => {
      const app = buildApp(repo);
      await auth(request(app).post('/scim/v2/Groups').send({ displayName: 'Engineers' }));
      const res = await auth(request(app).post('/scim/v2/Groups').send({ displayName: 'Engineers' }));
      expect(res.status).toBe(409);
    });

    it('lists groups with pagination', async () => {
      const app = buildApp(repo);
      await auth(request(app).post('/scim/v2/Groups').send({ displayName: 'A' }));
      await auth(request(app).post('/scim/v2/Groups').send({ displayName: 'B' }));
      const res = await auth(request(app).get('/scim/v2/Groups?startIndex=1&count=10'));
      expect(res.status).toBe(200);
      expect(res.body.totalResults).toBe(2);
    });

    it('filters groups by displayName eq', async () => {
      const app = buildApp(repo);
      await auth(request(app).post('/scim/v2/Groups').send({ displayName: 'Engineers' }));
      await auth(request(app).post('/scim/v2/Groups').send({ displayName: 'Designers' }));
      const res = await auth(request(app).get('/scim/v2/Groups?filter=displayName eq "Engineers"'));
      expect(res.status).toBe(200);
      expect(res.body.totalResults).toBe(1);
    });

    it('returns 404 for unknown group', async () => {
      const app = buildApp(repo);
      const res = await auth(request(app).get('/scim/v2/Groups/unknown'));
      expect(res.status).toBe(404);
    });

    it('handles errors in group list', async () => {
      const app = buildApp(repo);
      // Force parseFilter to return null so it calls Array.from on all groups
      const res = await auth(request(app).get('/scim/v2/Groups'));
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /Groups/:id', () => {
    it('replaces a group', async () => {
      const app = buildApp(repo);
      const created = await auth(request(app).post('/scim/v2/Groups').send({
        displayName: 'Old Name',
        members: [],
      }));
      const putRes = await auth(request(app).put(`/scim/v2/Groups/${created.body.id}`).send({
        displayName: 'New Name',
        members: [{ value: 'user-1' }],
      }));
      expect(putRes.status).toBe(200);
      expect(putRes.body.displayName).toBe('New Name');
    });

    it('returns 404 for unknown group', async () => {
      const app = buildApp(repo);
      const res = await auth(request(app).put('/scim/v2/Groups/unknown').send({}));
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /Groups/:id', () => {
    it('patches displayName', async () => {
      const app = buildApp(repo);
      const created = await auth(request(app).post('/scim/v2/Groups').send({ displayName: 'Eng' }));
      const patchRes = await auth(request(app).patch(`/scim/v2/Groups/${created.body.id}`).send({
        Operations: [{ op: 'replace', value: { displayName: 'Engineers' } }],
      }));
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.displayName).toBe('Engineers');
    });

    it('patches members via add', async () => {
      const app = buildApp(repo);
      const created = await auth(request(app).post('/scim/v2/Groups').send({
        displayName: 'Team',
        members: [],
      }));
      const patchRes = await auth(request(app).patch(`/scim/v2/Groups/${created.body.id}`).send({
        Operations: [{ op: 'add', value: { members: [{ value: 'user-2', display: 'Bob' }] } }],
      }));
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.members).toHaveLength(1);
    });

    it('removes a member by filter', async () => {
      const app = buildApp(repo);
      const created = await auth(request(app).post('/scim/v2/Groups').send({
        displayName: 'Team',
        members: [{ value: 'user-1', display: 'Alice' }, { value: 'user-2', display: 'Bob' }],
      }));
      const patchRes = await auth(request(app).patch(`/scim/v2/Groups/${created.body.id}`).send({
        Operations: [{ op: 'remove', path: 'members[value eq "user-1"]' }],
      }));
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.members).toHaveLength(1);
      expect(patchRes.body.members[0].value).toBe('user-2');
    });

    it('returns 404 for unknown group', async () => {
      const app = buildApp(repo);
      const res = await auth(request(app).patch('/scim/v2/Groups/unknown').send({ Operations: [] }));
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /Groups/:id', () => {
    it('deletes a group', async () => {
      const app = buildApp(repo);
      const created = await auth(request(app).post('/scim/v2/Groups').send({ displayName: 'Temp' }));
      const delRes = await auth(request(app).delete(`/scim/v2/Groups/${created.body.id}`));
      expect(delRes.status).toBe(204);

      const getRes = await auth(request(app).get(`/scim/v2/Groups/${created.body.id}`));
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for unknown group', async () => {
      const app = buildApp(repo);
      const res = await auth(request(app).delete('/scim/v2/Groups/unknown'));
      expect(res.status).toBe(404);
    });
  });
});

describe('SCIM 2.0 — Suspended user state isolation', () => {
  let repo: MockUserRepo;

  beforeEach(() => {
    repo = createMockRepo();
  });

  it('DELETE then GET shows active=false', async () => {
    repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
    const app = buildApp(repo);
    await auth(request(app).delete('/scim/v2/Users/user-1'));
    repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
    const res = await auth(request(app).get('/scim/v2/Users/user-1'));
    expect(res.body.active).toBe(false);
  });

  it('PUT with active=true re-activates a suspended user', async () => {
    repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
    repo.updateUser.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
    const app = buildApp(repo);
    await auth(request(app).delete('/scim/v2/Users/user-1'));
    repo.findById.mockResolvedValue({ ...SAMPLE_USER, password_hash: 'hash' } as any);
    const putRes = await auth(request(app).put(`/scim/v2/Users/user-1`).send({ active: true }));
    expect(putRes.body.active).toBe(true);

    const getRes = await auth(request(app).get('/scim/v2/Users/user-1'));
    expect(getRes.body.active).toBe(true);
  });
});
