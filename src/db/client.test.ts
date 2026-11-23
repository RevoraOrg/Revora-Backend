import { Pool } from "pg";
import {
  pool,
  getClient,
  query,
  closePool,
  dbHealth,
} from "./client";

// Mock the pg Pool
jest.mock("pg", () => {
  const mPool = {
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    options: { max: 10 },
  };
  return { Pool: jest.fn(() => mPool) };
});

describe("src/db/client", () => {
  let mockPoolInstance: any;

  beforeEach(() => {
    // The Pool constructor mock returns the mPool object from above
    mockPoolInstance = (Pool as unknown as jest.Mock).mock.results[0].value;
    jest.clearAllMocks();
  });

  describe("pool export", () => {
    it("should be an instance of Pool", () => {
      expect(pool).toBe(mockPoolInstance);
    });

    it("should register an error event handler on creation", () => {
      expect(mockPoolInstance.on).toHaveBeenCalledWith("error", expect.any(Function));
    });
  });

  describe("getClient", () => {
    it("should call pool.connect() and return the client", async () => {
      const mockClient = { release: jest.fn() };
      mockPoolInstance.connect.mockResolvedValue(mockClient);
      
      const client = await getClient();
      
      expect(mockPoolInstance.connect).toHaveBeenCalled();
      expect(client).toBe(mockClient);
    });

    it("should propagate errors from pool.connect()", async () => {
      mockPoolInstance.connect.mockRejectedValue(new Error("Connection failed"));
      await expect(getClient()).rejects.toThrow("Connection failed");
    });
  });

  describe("query", () => {
    it("should call pool.query() with sql and parameters", async () => {
      const mockResult = { rows: [{ id: 1 }] };
      mockPoolInstance.query.mockResolvedValue(mockResult);
      
      const result = await query("SELECT * FROM users WHERE id = $1", [1]);
      
      expect(mockPoolInstance.query).toHaveBeenCalledWith("SELECT * FROM users WHERE id = $1", [1]);
      expect(result).toBe(mockResult);
    });

    it("should call pool.query() with sql only if parameters are omitted", async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: [] });
      
      await query("SELECT 1");
      
      expect(mockPoolInstance.query).toHaveBeenCalledWith("SELECT 1", undefined);
    });

    it("should propagate errors from pool.query()", async () => {
      mockPoolInstance.query.mockRejectedValue(new Error("Query failed"));
      await expect(query("SELECT 1")).rejects.toThrow("Query failed");
    });
  });

  describe("closePool", () => {
    it("should call pool.end()", async () => {
      mockPoolInstance.end.mockResolvedValue(undefined);
      await closePool();
      expect(mockPoolInstance.end).toHaveBeenCalled();
    });
  });

  describe("dbHealth", () => {
    it("should return healthy status when query succeeds", async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
      
      const result = await dbHealth();
      
      expect(mockPoolInstance.query).toHaveBeenCalledWith("SELECT 1");
      expect(result.healthy).toBe(true);
      expect(typeof result.latencyMs).toBe("number");
      expect(result.error).toBeUndefined();
      expect(result.pool).toEqual({
        totalCount: 2,
        idleCount: 1,
        waitingCount: 0,
        maxConnections: 10,
      });
    });

    it("should return unhealthy status when query throws an Error", async () => {
      mockPoolInstance.query.mockRejectedValue(new Error("DB Timeout"));
      
      const result = await dbHealth();
      
      expect(result.healthy).toBe(false);
      expect(typeof result.latencyMs).toBe("number");
      expect(result.error).toBe("DB Timeout");
      expect(result.pool).toEqual({
        totalCount: 2,
        idleCount: 1,
        waitingCount: 0,
        maxConnections: 10,
      });
    });

    it("should fallback to String(err) if thrown object is not an Error", async () => {
      mockPoolInstance.query.mockRejectedValue("Non-error object thrown");
      
      const result = await dbHealth();
      
      expect(result.healthy).toBe(false);
      expect(result.error).toBe("Non-error object thrown");
    });
    
    it("should handle missing pool.options.max fallback", async () => {
      mockPoolInstance.options = {}; // simulate missing max option
      mockPoolInstance.query.mockResolvedValue({ rows: [] });
      
      const result = await dbHealth();
      expect(result.pool?.maxConnections).toBe(10); // fallback is 10
    });
  });
});
