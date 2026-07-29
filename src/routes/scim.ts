import { Router, Request, Response } from 'express';
import { UserRepository, SafeUser } from '../db/repositories/userRepository';
import { globalMetrics } from '../lib/metrics';
import { createScimAuth } from '../middleware/scimAuth';

const SCIM_CORE_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_CORE_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_API_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_API_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_API_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  meta: {
    resourceType: string;
    created: string;
    lastModified: string;
    version: string;
    location: string;
  };
  userName: string;
  name?: ScimName;
  displayName?: string;
  emails?: ScimEmail[];
  active: boolean;
  groups?: Array<{ value: string; $ref: string; display?: string }>;
}

interface ScimMember {
  value: string;
  $ref: string;
  display?: string;
}

interface ScimGroup {
  schemas: string[];
  id: string;
  externalId?: string;
  meta: {
    resourceType: string;
    created: string;
    lastModified: string;
    version: string;
    location: string;
  };
  displayName: string;
  members?: ScimMember[];
}

interface ScimListResponse {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: any[];
}

interface GroupRecord {
  id: string;
  displayName: string;
  members: ScimMember[];
  externalId?: string;
  created: Date;
  lastModified: Date;
}

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function scimError(status: number, scimType: string, detail: string) {
  return { schemas: [SCIM_API_ERROR], status, scimType, detail };
}

function userToScim(
  u: SafeUser,
  active: boolean,
  baseUrl: string,
): ScimUser {
  const parts = (u.name ?? '').split(' ');
  const givenName = parts[0] || undefined;
  const familyName = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
  const formatted = [givenName, familyName].filter(Boolean).join(' ') || undefined;

  return {
    schemas: [SCIM_CORE_USER],
    id: u.id,
    meta: {
      resourceType: 'User',
      created: u.created_at instanceof Date ? u.created_at.toISOString() : String(u.created_at),
      lastModified: u.updated_at instanceof Date ? u.updated_at.toISOString() : String(u.updated_at),
      version: `W/"${u.updated_at instanceof Date ? u.updated_at.getTime().toString(36) : ''}"`,
      location: `${baseUrl}/Users/${u.id}`,
    },
    userName: u.email,
    name: formatted ? { formatted, givenName, familyName } : undefined,
    displayName: u.name ?? undefined,
    emails: [{ value: u.email, primary: true }],
    active,
  };
}

function groupToScim(g: GroupRecord, baseUrl: string): ScimGroup {
  return {
    schemas: [SCIM_CORE_GROUP],
    id: g.id,
    meta: {
      resourceType: 'Group',
      created: g.created.toISOString(),
      lastModified: g.lastModified.toISOString(),
      version: `W/"${g.lastModified.getTime().toString(36)}"`,
      location: `${baseUrl}/Groups/${g.id}`,
    },
    displayName: g.displayName,
    members: g.members.length > 0 ? g.members : undefined,
  };
}

function parseFilter(filter?: string): { field: string; op: string; value: string } | null {
  if (!filter) return null;
  const m = filter.match(/^(\w+)\s+(eq|co|sw|pr|gt|ge|lt|le)\s+"([^"]*)"$/);
  if (!m) return null;
  return { field: m[1], op: m[2], value: m[3] };
}

export function createScimRouter(
  userRepo: UserRepository,
  scimToken: string,
  baseUrl: string = '/scim/v2',
): Router {
  const groups = new Map<string, GroupRecord>();
  const groupByName = new Map<string, string>();
  const suspendedUsers = new Set<string>();
  const router = Router();
  const authMiddleware = createScimAuth(scimToken);

  router.use(authMiddleware);

  function emitOp(operation: string, resource: string): void {
    globalMetrics.incrementCounter(
      'scim_operation_total',
      { operation, resource },
      1,
      'SCIM operation counter',
    );
  }

  // --- ServiceProviderConfig ---
  router.get('/ServiceProviderConfig', (_req: Request, res: Response) => {
    emitOp('read', 'ServiceProviderConfig');
    res.json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: true },
      authenticationSchemes: [{
        name: 'OAuth Bearer Token',
        description: 'Bearer token passed via Authorization header',
        specUri: 'https://tools.ietf.org/html/rfc6750',
        type: 'oauthbearertoken',
        primary: true,
      }],
    });
  });

  // --- Schemas ---
  router.get('/Schemas', (_req: Request, res: Response) => {
    emitOp('read', 'Schemas');
    res.json({
      schemas: [SCIM_API_LIST],
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 3,
      Resources: [
        {
          id: SCIM_CORE_USER,
          name: 'User',
          description: 'SCIM Core User Schema',
          attributes: [
            { name: 'userName', type: 'string', required: true, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'server' },
            { name: 'name', type: 'complex', required: false, mutability: 'readWrite', returned: 'default', subAttributes: [
              { name: 'formatted', type: 'string' },
              { name: 'givenName', type: 'string' },
              { name: 'familyName', type: 'string' },
            ]},
            { name: 'displayName', type: 'string', required: false, mutability: 'readWrite', returned: 'default' },
            { name: 'emails', type: 'complex', required: false, mutability: 'readWrite', returned: 'default', multiValued: true, subAttributes: [
              { name: 'value', type: 'string' },
              { name: 'type', type: 'string' },
              { name: 'primary', type: 'boolean' },
            ]},
            { name: 'active', type: 'boolean', required: false, mutability: 'readWrite', returned: 'default' },
          ],
        },
        {
          id: SCIM_CORE_GROUP,
          name: 'Group',
          description: 'SCIM Core Group Schema',
          attributes: [
            { name: 'displayName', type: 'string', required: true, mutability: 'readWrite', returned: 'default' },
            { name: 'members', type: 'complex', required: false, mutability: 'readWrite', returned: 'default', multiValued: true, subAttributes: [
              { name: 'value', type: 'string' },
              { name: '$ref', type: 'reference' },
              { name: 'display', type: 'string' },
            ]},
          ],
        },
        {
          id: 'urn:ietf:params:scim:schemas:core:2.0:EnterpriseUser',
          name: 'EnterpriseUser',
          description: 'SCIM Enterprise User Schema Extension',
          attributes: [],
        },
      ],
    });
  });

  router.get('/Schemas/:schemaId', (req: Request, res: Response) => {
    emitOp('read', 'Schemas');
    const id = req.params.schemaId;
    const schemas: Record<string, any> = {
      [SCIM_CORE_USER]: {
        id: SCIM_CORE_USER,
        name: 'User',
        description: 'SCIM Core User Schema',
        attributes: [
          { name: 'userName', type: 'string', required: true, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'server' },
          { name: 'name', type: 'complex', required: false, mutability: 'readWrite', returned: 'default', subAttributes: [
            { name: 'formatted', type: 'string' },
            { name: 'givenName', type: 'string' },
            { name: 'familyName', type: 'string' },
          ]},
          { name: 'displayName', type: 'string', required: false, mutability: 'readWrite', returned: 'default' },
          { name: 'emails', type: 'complex', required: false, mutability: 'readWrite', returned: 'default', multiValued: true, subAttributes: [
            { name: 'value', type: 'string' },
            { name: 'type', type: 'string' },
            { name: 'primary', type: 'boolean' },
          ]},
          { name: 'active', type: 'boolean', required: false, mutability: 'readWrite', returned: 'default' },
        ],
      },
      [SCIM_CORE_GROUP]: {
        id: SCIM_CORE_GROUP,
        name: 'Group',
        description: 'SCIM Core Group Schema',
        attributes: [
          { name: 'displayName', type: 'string', required: true, mutability: 'readWrite', returned: 'default' },
          { name: 'members', type: 'complex', required: false, mutability: 'readWrite', returned: 'default', multiValued: true, subAttributes: [
            { name: 'value', type: 'string' },
            { name: '$ref', type: 'reference' },
            { name: 'display', type: 'string' },
          ]},
        ],
      },
    };
    const s = schemas[id];
    if (!s) {
      res.status(404).json(scimError(404, 'unknown', `Schema ${id} not found`));
      return;
    }
    res.json(s);
  });

  // --- ResourceTypes ---
  router.get('/ResourceTypes', (_req: Request, res: Response) => {
    emitOp('read', 'ResourceTypes');
    res.json({
      schemas: [SCIM_API_LIST],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        {
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          description: 'SCIM User Resource',
          schema: SCIM_CORE_USER,
          schemaExtensions: [{ schema: 'urn:ietf:params:scim:schemas:core:2.0:EnterpriseUser', required: false }],
          meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/User`, created: '2026-01-01T00:00:00Z', lastModified: '2026-01-01T00:00:00Z', version: 'W/"1"' },
        },
        {
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          description: 'SCIM Group Resource',
          schema: SCIM_CORE_GROUP,
          meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/Group`, created: '2026-01-01T00:00:00Z', lastModified: '2026-01-01T00:00:00Z', version: 'W/"1"' },
        },
      ],
    });
  });

  // --- Users ---
  router.get('/Users', async (req: Request, res: Response) => {
    emitOp('read', 'Users');
    try {
      const startIndex = Math.max(1, parseInt(req.query.startIndex as string) || 1);
      const count = Math.min(200, Math.max(1, parseInt(req.query.count as string) || 100));
      const filter = parseFilter(req.query.filter as string);

      let users: SafeUser[] = [];
      if (filter && filter.field === 'userName' && filter.op === 'eq') {
        const u = await userRepo.findByEmail(filter.value);
        if (u) {
          const { password_hash: _, ...safe } = u;
          users = [safe];
        }
      } else if (filter && filter.field === 'id' && filter.op === 'eq') {
        const u = await userRepo.findById(filter.value);
        if (u) {
          const { password_hash: _, ...safe } = u;
          users = [safe];
        }
      } else {
        users = [];
      }

      const allResources = users.map(u => userToScim(u, !suspendedUsers.has(u.id), baseUrl));
      const paged = allResources.slice(startIndex - 1, startIndex - 1 + count);

      const listResp: ScimListResponse = {
        schemas: [SCIM_API_LIST],
        totalResults: allResources.length,
        startIndex,
        itemsPerPage: paged.length,
        Resources: paged,
      };
      res.json(listResp);
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.post('/Users', async (req: Request, res: Response) => {
    emitOp('create', 'Users');
    try {
      const body = req.body;
      const userName = body?.userName;
      if (!userName || typeof userName !== 'string') {
        res.status(400).json(scimError(400, 'invalidValue', 'userName is required'));
        return;
      }
      const existing = await userRepo.findByEmail(userName);
      if (existing) {
        const { password_hash: _, ...safe } = existing;
        const scim = userToScim(safe, !suspendedUsers.has(existing.id), baseUrl);
        res.status(201).json(scim);
        return;
      }
      const name = body?.displayName ?? body?.name?.formatted ?? '';
      const givenName = body?.name?.givenName;
      const familyName = body?.name?.familyName;
      const displayName = givenName || familyName
        ? [givenName, familyName].filter(Boolean).join(' ')
        : name;

      const created = await userRepo.createUser({
        email: userName,
        password_hash: crypto.randomUUID(),
        name: displayName || undefined,
        role: 'startup',
      });
      const { password_hash: _, ...safe } = created;
      const scim = userToScim(safe, true, baseUrl);
      res.status(201).json(scim);
    } catch (err: any) {
      if (err.constructor?.name === 'UniqueConstraintError') {
        res.status(409).json(scimError(409, 'uniqueness', 'Email already exists'));
        return;
      }
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.get('/Users/:id', async (req: Request, res: Response) => {
    emitOp('read', 'Users');
    try {
      const u = await userRepo.findById(req.params.id);
      if (!u) {
        res.status(404).json(scimError(404, 'unknown', `User ${req.params.id} not found`));
        return;
      }
      const { password_hash: _, ...safe } = u;
      res.json(userToScim(safe, !suspendedUsers.has(u.id), baseUrl));
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.put('/Users/:id', async (req: Request, res: Response) => {
    emitOp('replace', 'Users');
    try {
      const existing = await userRepo.findById(req.params.id);
      if (!existing) {
        res.status(404).json(scimError(404, 'unknown', `User ${req.params.id} not found`));
        return;
      }
      const body = req.body || {};
      const givenName = body?.name?.givenName;
      const familyName = body?.name?.familyName;
      const displayName = body?.displayName ?? body?.name?.formatted;
      const nameStr = givenName || familyName
        ? [givenName, familyName].filter(Boolean).join(' ')
        : (displayName || existing.name || '');

      const active = body?.active !== undefined ? body.active : !suspendedUsers.has(existing.id);

      const updated = await userRepo.updateUser({
        id: existing.id,
        email: body?.userName || existing.email,
        name: nameStr || undefined,
      });
      const { password_hash: _, ...safe } = updated;
      if (!active) suspendedUsers.add(existing.id);
      else suspendedUsers.delete(existing.id);
      res.json(userToScim(safe, active, baseUrl));
    } catch (err: any) {
      if (err.constructor?.name === 'UniqueConstraintError') {
        res.status(409).json(scimError(409, 'uniqueness', 'Email already exists'));
        return;
      }
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.patch('/Users/:id', async (req: Request, res: Response) => {
    emitOp('patch', 'Users');
    try {
      const existing = await userRepo.findById(req.params.id);
      if (!existing) {
        res.status(404).json(scimError(404, 'unknown', `User ${req.params.id} not found`));
        return;
      }
      const body = req.body || {};
      const operations = body.Operations || body.operations || [];

      let newEmail = existing.email;
      let newName = existing.name;
      let newActive = !suspendedUsers.has(existing.id);

      for (const op of operations) {
        if (op.op === 'replace' && op.value) {
          if (op.value.userName) newEmail = op.value.userName;
          if (op.value.displayName) newName = op.value.displayName;
          if (op.value.name?.givenName || op.value.name?.familyName) {
            const gn = op.value.name.givenName || '';
            const fn = op.value.name.familyName || '';
            const combined = [gn, fn].filter(Boolean).join(' ');
            if (combined) newName = combined;
          }
          if (op.value.active !== undefined) newActive = op.value.active;
        } else if (op.op === 'replace' && op.path === 'userName') {
          newEmail = op.value;
        } else if (op.op === 'replace' && op.path === 'active') {
          newActive = op.value === true || op.value === 'true';
        } else if (op.op === 'replace' && op.path === 'displayName') {
          newName = op.value;
        }
      }

      const updated = await userRepo.updateUser({
        id: existing.id,
        email: newEmail,
        name: newName,
      });
      const { password_hash: _, ...safe } = updated;
      if (!newActive) suspendedUsers.add(existing.id);
      else suspendedUsers.delete(existing.id);
      res.json(userToScim(safe, newActive, baseUrl));
    } catch (err: any) {
      if (err.constructor?.name === 'UniqueConstraintError') {
        res.status(409).json(scimError(409, 'uniqueness', 'Email already exists'));
        return;
      }
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.delete('/Users/:id', async (req: Request, res: Response) => {
    emitOp('delete', 'Users');
    try {
      const u = await userRepo.findById(req.params.id);
      if (!u) {
        res.status(404).json(scimError(404, 'unknown', `User ${req.params.id} not found`));
        return;
      }
      suspendedUsers.add(u.id);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  // --- Groups ---
  router.get('/Groups', (req: Request, res: Response) => {
    emitOp('read', 'Groups');
    try {
      const startIndex = Math.max(1, parseInt(req.query.startIndex as string) || 1);
      const count = Math.min(200, Math.max(1, parseInt(req.query.count as string) || 100));
      const filter = parseFilter(req.query.filter as string);
      let all: GroupRecord[] = [];

      if (filter && filter.field === 'displayName' && filter.op === 'eq') {
        const gid = groupByName.get(filter.value);
        const g = gid ? groups.get(gid) : undefined;
        if (g) all = [g];
      } else {
        all = Array.from(groups.values());
      }

      const paged = all.slice(startIndex - 1, startIndex - 1 + count);
      const listResp: ScimListResponse = {
        schemas: [SCIM_API_LIST],
        totalResults: all.length,
        startIndex,
        itemsPerPage: paged.length,
        Resources: paged.map(g => groupToScim(g, baseUrl)),
      };
      res.json(listResp);
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.post('/Groups', (req: Request, res: Response) => {
    emitOp('create', 'Groups');
    try {
      const body = req.body || {};
      const displayName = body?.displayName;
      if (!displayName || typeof displayName !== 'string') {
        res.status(400).json(scimError(400, 'invalidValue', 'displayName is required'));
        return;
      }
      if (groupByName.has(displayName)) {
        res.status(409).json(scimError(409, 'uniqueness', `Group ${displayName} already exists`));
        return;
      }
      const now = new Date();
      const g: GroupRecord = {
        id: newId(),
        displayName,
        members: (body?.members || []).map((m: any) => ({
          value: m.value,
          $ref: m.$ref || `${baseUrl}/Users/${m.value}`,
          display: m.display,
        })),
        externalId: body?.externalId,
        created: now,
        lastModified: now,
      };
      groups.set(g.id, g);
      groupByName.set(g.displayName, g.id);
      res.status(201).json(groupToScim(g, baseUrl));
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.get('/Groups/:id', (req: Request, res: Response) => {
    emitOp('read', 'Groups');
    try {
      const g = findGroup(groups, groupByName, req.params.id);
      if (!g) {
        res.status(404).json(scimError(404, 'unknown', `Group ${req.params.id} not found`));
        return;
      }
      res.json(groupToScim(g, baseUrl));
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.put('/Groups/:id', (req: Request, res: Response) => {
    emitOp('replace', 'Groups');
    try {
      const g = findGroup(groups, groupByName, req.params.id);
      if (!g) {
        res.status(404).json(scimError(404, 'unknown', `Group ${req.params.id} not found`));
        return;
      }
      const body = req.body || {};
      const displayName = body?.displayName;
      if (displayName && displayName !== g.displayName) {
        groupByName.delete(g.displayName);
        g.displayName = displayName;
        groupByName.set(g.displayName, g.id);
      }
      g.members = (body?.members || []).map((m: any) => ({
        value: m.value,
        $ref: m.$ref || `${baseUrl}/Users/${m.value}`,
        display: m.display,
      }));
      g.lastModified = new Date();
      res.json(groupToScim(g, baseUrl));
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.patch('/Groups/:id', (req: Request, res: Response) => {
    emitOp('patch', 'Groups');
    try {
      const g = findGroup(groups, groupByName, req.params.id);
      if (!g) {
        res.status(404).json(scimError(404, 'unknown', `Group ${req.params.id} not found`));
        return;
      }
      const body = req.body || {};
      const operations = body.Operations || body.operations || [];

      for (const op of operations) {
        if (op.op === 'replace' && op.value) {
          if (op.value.displayName) {
            const oldName = g.displayName;
            groupByName.delete(oldName);
            g.displayName = op.value.displayName;
            groupByName.set(g.displayName, g.id);
          }
          if (op.value.members) {
            g.members = op.value.members.map((m: any) => ({
              value: m.value,
              $ref: m.$ref || `${baseUrl}/Users/${m.value}`,
              display: m.display,
            }));
          }
        } else if (op.op === 'add' && op.value?.members) {
          for (const m of op.value.members) {
            if (!g.members.some(ex => ex.value === m.value)) {
              g.members.push({
                value: m.value,
                $ref: m.$ref || `${baseUrl}/Users/${m.value}`,
                display: m.display,
              });
            }
          }
        } else if (op.op === 'remove') {
          if (op.path?.startsWith('members')) {
            const valMatch = op.path.match(/\[value eq "([^"]+)"\]/);
            if (valMatch) {
              g.members = g.members.filter(m => m.value !== valMatch[1]);
            }
          }
        }
      }
      g.lastModified = new Date();
      res.json(groupToScim(g, baseUrl));
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  router.delete('/Groups/:id', (req: Request, res: Response) => {
    emitOp('delete', 'Groups');
    try {
      const g = findGroup(groups, groupByName, req.params.id);
      if (!g) {
        res.status(404).json(scimError(404, 'unknown', `Group ${req.params.id} not found`));
        return;
      }
      groupByName.delete(g.displayName);
      groups.delete(g.id);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json(scimError(500, 'internal', err.message));
    }
  });

  return router;
}

function findGroup(groups: Map<string, GroupRecord>, groupByName: Map<string, string>, idOrName: string): GroupRecord | undefined {
  const byId = groups.get(idOrName);
  if (byId) return byId;
  const nameId = groupByName.get(idOrName);
  return nameId ? groups.get(nameId) : undefined;
}

export { createScimAuth } from '../middleware/scimAuth';
