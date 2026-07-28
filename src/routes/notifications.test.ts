import assert from "assert";
import { AppError } from "../lib/errors";
import { createNotificationHandlers, NotificationRepo } from "./notifications";

const U1 = "550e8400-e29b-41d4-a716-446655440000";
const U2 = "550e8400-e29b-41d4-a716-446655440001";
const N1 = "550e8400-e29b-41d4-a716-446655440002";
const N2 = "550e8400-e29b-41d4-a716-446655440003";
const N3 = "550e8400-e29b-41d4-a716-446655440004";

// Mock notification repo
class MockNotificationRepo {
  notifications: any[] = [];
  marked: string[] = [];
  constructor(rows: any[]) {
    this.notifications = rows;
  }
  async listByUser(userId: string) {
    return this.notifications.filter((n) => n.user_id === userId);
  }
  async markRead(id: string, userId: string) {
    const idx = this.notifications.findIndex(
      (n) => n.id === id && n.user_id === userId,
    );
    if (idx === -1) return false;
    this.notifications[idx].read = true;
    this.marked.push(id);
    return true;
  }
  async markReadBulk(ids: string[], userId: string) {
    let count = 0;
    for (const id of ids) {
      const ok = await this.markRead(id, userId);
      if (ok) count++;
    }
    return count;
  }
}

function makeReq(user: any, params: any = {}, body: any = {}) {
  return { params, body, user } as any;
}

function makeRes() {
  let statusCode = 200;
  let jsonData: any = null;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(obj: any) {
      jsonData = obj;
      return this;
    },
    _get() {
      return { statusCode, jsonData };
    },
  } as any;
}

describe("notifications routes", () => {
  let repo: MockNotificationRepo;
  let handlers: any;

  beforeEach(() => {
    const rows = [
      {
        id: N1,
        user_id: U1,
        message: "m1",
        read: false,
        type: "info",
        created_at: new Date(),
      },
      {
        id: N2,
        user_id: U1,
        message: "m2",
        read: false,
        type: "alert",
        created_at: new Date(),
      },
      {
        id: N3,
        user_id: U2,
        message: "m3",
        read: false,
        type: "info",
        created_at: new Date(),
      },
    ];
    repo = new MockNotificationRepo(rows);
    handlers = createNotificationHandlers(repo as any);
  });

  it("lists notifications for user", async () => {
    const req = makeReq({ id: U1 });
    const res = makeRes();
    await handlers.getNotifications(req, res, (e: any) => {
      throw e;
    });

    const { statusCode, jsonData } = res._get();
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(jsonData.notifications.length, 2);
  });

  it("marks single notification as read", async () => {
    const req = makeReq({ id: U1 }, { id: N1 });
    const res = makeRes();
    await handlers.markRead(req, res, (e: any) => {
      throw e;
    });

    const { statusCode, jsonData } = res._get();
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(jsonData.marked, 1);
    assert.strictEqual(repo.notifications.find((n) => n.id === N1).read, true);
  });

  it("marks multiple notifications as read (bulk via path)", async () => {
    const req = makeReq({ id: U1 }, { id: "bulk" }, { ids: [N1, N2] });
    const res = makeRes();
    await handlers.markRead(req, res, (e: any) => {
      throw e;
    });

    const { statusCode, jsonData } = res._get();
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(jsonData.marked, 2);
  });

  it("returns 401 when unauthorized", async () => {
    const req = makeReq(null);
    const res = makeRes();
    let capturedError: any;
    await handlers.getNotifications(req, res, (e: any) => {
      capturedError = e;
    });

    assert(capturedError instanceof AppError);
    assert.strictEqual(capturedError.httpCode, 401);
  });

  it("returns 404 when notification not found or belongs to another user", async () => {
    const req = makeReq({ id: U1 }, { id: N3 }); // N3 belongs to U2
    const res = makeRes();
    let capturedError: any;
    await handlers.markRead(req, res, (e: any) => {
      capturedError = e;
    });

    assert(capturedError instanceof AppError);
    assert.strictEqual(capturedError.httpCode, 404);
  });

  it("returns 400 for invalid UUID in params", async () => {
    const req = makeReq({ id: U1 }, { id: "invalid-uuid" });
    const res = makeRes();
    let capturedError: any;
    await handlers.markRead(req, res, (e: any) => {
      capturedError = e;
    });

    assert(capturedError instanceof AppError);
    assert.strictEqual(capturedError.httpCode, 400);
    assert.strictEqual((capturedError as any).code, "VALIDATION_ERROR");
  });

  it("returns 400 for invalid UUID in bulk body", async () => {
    const req = makeReq({ id: U1 }, { id: "bulk" }, { ids: ["invalid-uuid"] });
    const res = makeRes();
    let capturedError: any;
    await handlers.markRead(req, res, (e: any) => {
      capturedError = e;
    });

    assert(capturedError instanceof AppError);
    assert.strictEqual(capturedError.httpCode, 400);
    assert.strictEqual((capturedError as any).code, "VALIDATION_ERROR");
  });

  it("returns 400 when bulk path used without ids in body", async () => {
    const req = makeReq({ id: U1 }, { id: "bulk" }, { ids: [] });
    const res = makeRes();
    let capturedError: any;
    await handlers.markRead(req, res, (e: any) => {
      capturedError = e;
    });

    assert(capturedError instanceof AppError);
    assert.strictEqual(capturedError.httpCode, 400);
  });

  it("returns 400 when bulk mark not supported by repo", async () => {
    const repoWithoutBulk: NotificationRepo = {
      listByUser: repo.listByUser.bind(repo),
      markRead: repo.markRead.bind(repo),
    };
    const handlersWithoutBulk = createNotificationHandlers(repoWithoutBulk);

    const req = makeReq({ id: U1 }, { id: "bulk" }, { ids: [N1] });
    const res = makeRes();
    let capturedError: any;
    await handlersWithoutBulk.markRead(req, res, (e: any) => {
      capturedError = e;
    });

    assert(capturedError instanceof AppError);
    assert.strictEqual(capturedError.httpCode, 400);
  });

  it("handles error in getNotifications", async () => {
    const erroringRepo: NotificationRepo = {
      async listByUser() {
        throw new Error("Database error");
      },
      async markRead() {
        return false;
      },
    };
    const erroringHandlers = createNotificationHandlers(erroringRepo);

    const req = makeReq({ id: U1 });
    const res = makeRes();
    let capturedError: any;
    await erroringHandlers.getNotifications(req, res, (e: any) => {
      capturedError = e;
    });

    assert(capturedError instanceof Error);
    assert.strictEqual(capturedError.message, "Database error");
  });

  it("handles error in markRead", async () => {
    const erroringRepo: NotificationRepo = {
      async listByUser() {
        return [];
      },
      async markRead() {
        throw new Error("Database error");
      },
    };
    const erroringHandlers = createNotificationHandlers(erroringRepo);

    const req = makeReq({ id: U1 }, { id: N1 });
    const res = makeRes();
    let capturedError: any;
    await erroringHandlers.markRead(req, res, (e: any) => {
      capturedError = e;
    });

    assert(capturedError instanceof Error);
    assert.strictEqual(capturedError.message, "Database error");
  });
});
