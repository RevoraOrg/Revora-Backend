/**
 * The module under test reads environment variables at import time and
 * constructs real `pg` Pools. Tests therefore mock `pg` (so neither
 * `pool` nor `replicaPool` touches the network) and mock the lag monitor,
 * then reload `./pool` under controlled env state per scenario.
 *
 * The mocked `Pool` records its constructor config on the class so tests
 * can assert which connection string / pool options the module built.
 */

jest.mock("pg", () => {
  class Pool {
    static capturedConfigs: unknown[] = [];

    query = jest
      .fn()
      .mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });

    end = jest.fn().mockResolvedValue(undefined);

    constructor(config?: unknown) {
      Pool.capturedConfigs.push(config);
    }
  }

  return { Pool };
});

jest.mock("./replicaLagMonitor", () => ({
  ReplicaLagMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    isReplicaHealthy: jest.fn(),
  })),
}));

const ENV_KEYS = [
  "REPLICA_DB_URL",
  "REPLICA_LAG_THRESHOLD_MS",
  "REPLICA_POLL_INTERVAL_MS",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
] as const;

interface LoadedPool {
  mod: typeof import("./pool");
  PoolCtor: { capturedConfigs: unknown[] };
  ReplicaLagMonitorCtor: jest.Mock;
  incrementCounter: jest.SpyInstance;
}

/**
 * Reload `./pool` inside an isolated module registry so import-time env reads
 * and module-level Pool construction happen fresh per call. All mock handles,
 * including the (isolated) metrics instance, are captured inside the same
 * registry so assertions see the exact instances the module under test used.
 */
function loadPoolModule(): LoadedPool {
  let handle: LoadedPool | undefined;
  jest.isolateModules(() => {
    const { Pool } = jest.requireMock("pg") as {
      Pool: unknown;
    };
    const { ReplicaLagMonitor } = jest.requireMock("./replicaLagMonitor") as {
      ReplicaLagMonitor: unknown;
    };
    const { globalMetrics: isolatedMetrics } = jest.requireActual(
      "../lib/metrics",
    ) as {
      globalMetrics: { incrementCounter: (name: string) => void };
    };
    const incrementCounter = jest
      .spyOn(isolatedMetrics, "incrementCounter")
      .mockImplementation(() => undefined);
    const mod = jest.requireActual("./pool");
    handle = {
      mod,
      PoolCtor: Pool as unknown as { capturedConfigs: unknown[] },
      ReplicaLagMonitorCtor: ReplicaLagMonitor as unknown as jest.Mock,
      incrementCounter,
    };
  });
  return handle!;
}

describe("db/pool", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    jest.restoreAllMocks();
  });

  describe("primary pool construction", () => {
    it("builds the primary pool with default options when no env is set", () => {
      const { mod, PoolCtor } = loadPoolModule();
      const config = PoolCtor.capturedConfigs[0] as Record<string, unknown>;

      expect(mod.pool).toBeDefined();
      expect(config).toMatchObject({
        host: "localhost",
        port: 5432,
        database: "revora",
        user: "postgres",
        password: "",
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 2_000,
      });
    });

    it("honours DB_* env overrides when set", () => {
      process.env.DB_HOST = "db.internal.example";
      process.env.DB_PORT = "6432";
      process.env.DB_NAME = "prod";
      process.env.DB_USER = "app";
      process.env.DB_PASSWORD = "secret";

      const { PoolCtor } = loadPoolModule();
      const config = PoolCtor.capturedConfigs[0] as Record<string, unknown>;

      expect(config).toMatchObject({
        host: "db.internal.example",
        port: 6432,
        database: "prod",
        user: "app",
        password: "secret",
      });
    });
  });

  describe("replica configuration (import-time)", () => {
    it("leaves replicaPool and lagMonitor null without REPLICA_DB_URL", () => {
      const { mod } = loadPoolModule();
      expect(mod.replicaPool).toBeNull();
      expect(mod.lagMonitor).toBeNull();
    });

    it("builds replicaPool and starts the lag monitor when REPLICA_DB_URL is set", () => {
      process.env.REPLICA_DB_URL = "postgres://replica:5432/revora";
      const { mod, ReplicaLagMonitorCtor } = loadPoolModule();

      expect(mod.replicaPool).toBeDefined();
      expect(mod.lagMonitor).toBeDefined();
      expect(ReplicaLagMonitorCtor).toHaveBeenCalledTimes(1);
      expect(mod.lagMonitor!.start as jest.Mock).toHaveBeenCalled();
    });

    it("parses lag threshold and poll interval env values", () => {
      process.env.REPLICA_DB_URL = "postgres://replica:5432/revora";
      process.env.REPLICA_LAG_THRESHOLD_MS = "8000";
      process.env.REPLICA_POLL_INTERVAL_MS = "2000";

      const { ReplicaLagMonitorCtor } = loadPoolModule();
      const options = ReplicaLagMonitorCtor.mock.calls[0][0];

      expect(options).toMatchObject({
        replicaUrl: "postgres://replica:5432/revora",
        lagThresholdMs: 8000,
        pollIntervalMs: 2000,
      });
    });
  });

  describe("readQuery routing", () => {
    it("routes reads to the primary when no replica is configured", async () => {
      const { mod, incrementCounter } = loadPoolModule();

      await mod.readQuery("SELECT 1");
      await mod.readQuery("SELECT $1::int AS n", [42]);

      expect(mod.pool.query).toHaveBeenCalledWith("SELECT 1", undefined);
      expect(mod.pool.query).toHaveBeenCalledWith("SELECT $1::int AS n", [42]);
      expect(incrementCounter).not.toHaveBeenCalled();
    });

    it("routes reads to the replica when it is healthy", async () => {
      process.env.REPLICA_DB_URL = "postgres://replica:5432/revora";
      const { mod, incrementCounter } = loadPoolModule();
      (mod.lagMonitor!.isReplicaHealthy as jest.Mock).mockReturnValue(true);

      await mod.readQuery("SELECT * FROM users WHERE id = $1", ["u1"]);

      expect(mod.replicaPool!.query).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE id = $1",
        ["u1"],
      );
      expect(mod.pool.query).not.toHaveBeenCalled();
      expect(incrementCounter).not.toHaveBeenCalled();
    });

    it("routes reads to the primary and emits db.replica.route_primary when lagging", async () => {
      process.env.REPLICA_DB_URL = "postgres://replica:5432/revora";
      const { mod, incrementCounter } = loadPoolModule();
      (mod.lagMonitor!.isReplicaHealthy as jest.Mock).mockReturnValue(false);

      await mod.readQuery("SELECT 1");

      expect(mod.pool.query).toHaveBeenCalledWith("SELECT 1", undefined);
      expect(mod.replicaPool!.query).not.toHaveBeenCalled();
      expect(incrementCounter).toHaveBeenCalledWith(
        "db.replica.route_primary",
        undefined,
        1,
        expect.any(String),
      );
    });

    it("re-evaluates health per query (no cross-query caching)", async () => {
      process.env.REPLICA_DB_URL = "postgres://replica:5432/revora";
      const { mod } = loadPoolModule();
      const healthy = mod.lagMonitor!.isReplicaHealthy as jest.Mock;

      healthy.mockReturnValue(true);
      await mod.readQuery("SELECT health");
      expect(mod.replicaPool!.query).toHaveBeenCalledTimes(1);

      healthy.mockReturnValue(false);
      await mod.readQuery("SELECT lagged");
      expect(mod.pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe("closeAllPools", () => {
    it("ends the primary pool when no replica is configured", async () => {
      const { mod } = loadPoolModule();

      await mod.closeAllPools();

      expect(mod.pool.end).toHaveBeenCalledTimes(1);
      expect(mod.lagMonitor).toBeNull();
    });

    it("stops the lag monitor and ends both pools when a replica is configured", async () => {
      process.env.REPLICA_DB_URL = "postgres://replica:5432/revora";
      const { mod } = loadPoolModule();

      await mod.closeAllPools();

      expect(mod.lagMonitor!.stop as jest.Mock).toHaveBeenCalledTimes(1);
      expect(mod.pool.end).toHaveBeenCalledTimes(1);
      expect(mod.replicaPool!.end).toHaveBeenCalledTimes(1);
    });
  });
});