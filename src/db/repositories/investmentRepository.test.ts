import {Pool, QueryResult} from "pg";
import {
  InvestmentRepository,
  Investment,
  CreateInvestmentInput,
} from "./investmentRepository";

describe("InvestmentRepository", () => {
  let repository: InvestmentRepository;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockPool: any;

  beforeEach(() => {
    // Mock Pool
    mockPool = {
      query: jest.fn(),
    };

    repository = new InvestmentRepository(mockPool);
  });

  describe("create", () => {
    it("should create an investment with default status", async () => {
      const input: CreateInvestmentInput = {
        investor_id: "investor-123",
        offering_id: "offering-456",
        amount: "10000.50",
      };

      const mockResult: QueryResult<Investment> = {
        rows: [
          {
            id: "investment-789",
            investor_id: "investor-123",
            offering_id: "offering-456",
            amount: "10000.50",
            status: "pending",
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
        command: "INSERT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO investments"),
        ["investor-123", "offering-456", "10000.50", "pending"],
      );
      expect(result.id).toBe("investment-789");
      expect(result.investor_id).toBe("investor-123");
      expect(result.offering_id).toBe("offering-456");
      expect(result.status).toBe("pending");
    });

    it("should create an investment with custom status", async () => {
      const input: CreateInvestmentInput = {
        investor_id: "investor-123",
        offering_id: "offering-456",
        amount: "10000.50",
        status: "completed",
      };

      const mockResult: QueryResult<Investment> = {
        rows: [
          {
            id: "investment-789",
            investor_id: "investor-123",
            offering_id: "offering-456",
            amount: "10000.50",
            status: "completed",
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
        command: "INSERT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO investments"),
        ["investor-123", "offering-456", "10000.50", "completed"],
      );
      expect(result.status).toBe("completed");
    });

    it("should throw error if creation fails", async () => {
      const input: CreateInvestmentInput = {
        investor_id: "investor-123",
        offering_id: "offering-456",
        amount: "10000.50",
      };

      const mockResult: QueryResult<Investment> = {
        rows: [],
        rowCount: 0,
        command: "INSERT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      await expect(repository.create(input)).rejects.toThrow(
        "Failed to create investment",
      );
    });
  });

  describe("getById", () => {
    it("should return investment when found", async () => {
      const id = "investment-789";

      const mockResult: QueryResult<Investment> = {
        rows: [
          {
            id: "investment-789",
            investor_id: "investor-123",
            offering_id: "offering-456",
            amount: "10000.50",
            status: "completed",
            created_at: new Date("2024-01-15"),
            updated_at: new Date("2024-01-15"),
          },
        ],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.getById(id);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM investments"),
        [id],
      );
      expect(result).not.toBeNull();
      expect(result?.id).toBe("investment-789");
      expect(result?.investor_id).toBe("investor-123");
    });

    it("should return null when investment not found", async () => {
      const id = "investment-999";

      const mockResult: QueryResult<Investment> = {
        rows: [],
        rowCount: 0,
        command: "SELECT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.getById(id);

      expect(result).toBeNull();
    });
  });

  describe("listByInvestor", () => {
    it("should return investments for an investor", async () => {
      const investorId = "investor-123";

      const mockResult: QueryResult<Investment> = {
        rows: [
          {
            id: "investment-1",
            investor_id: "investor-123",
            offering_id: "offering-456",
            amount: "10000.50",
            status: "completed",
            created_at: new Date("2024-01-15"),
            updated_at: new Date("2024-01-15"),
          },
          {
            id: "investment-2",
            investor_id: "investor-123",
            offering_id: "offering-789",
            amount: "5000.00",
            status: "pending",
            created_at: new Date("2024-01-10"),
            updated_at: new Date("2024-01-10"),
          },
        ],
        rowCount: 2,
        command: "SELECT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.listByInvestor(investorId);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM investments"),
        [investorId],
      );
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("investment-1");
      expect(result[1].id).toBe("investment-2");
    });

    it("should return empty array if no investments found", async () => {
      const investorId = "investor-999";

      const mockResult: QueryResult<Investment> = {
        rows: [],
        rowCount: 0,
        command: "SELECT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.listByInvestor(investorId);

      expect(result).toHaveLength(0);
    });
  });

  describe("listByOffering", () => {
    it("should return investments for an offering", async () => {
      const offeringId = "offering-456";

      const mockResult: QueryResult<Investment> = {
        rows: [
          {
            id: "investment-1",
            investor_id: "investor-123",
            offering_id: "offering-456",
            amount: "10000.50",
            status: "completed",
            created_at: new Date("2024-01-15"),
            updated_at: new Date("2024-01-15"),
          },
          {
            id: "investment-2",
            investor_id: "investor-456",
            offering_id: "offering-456",
            amount: "5000.00",
            status: "completed",
            created_at: new Date("2024-01-10"),
            updated_at: new Date("2024-01-10"),
          },
        ],
        rowCount: 2,
        command: "SELECT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.listByOffering(offeringId);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM investments"),
        [offeringId],
      );
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("investment-1");
      expect(result[1].id).toBe("investment-2");
    });

    it("should return empty array if no investments found", async () => {
      const offeringId = "offering-999";

      const mockResult: QueryResult<Investment> = {
        rows: [],
        rowCount: 0,
        command: "SELECT",
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.listByOffering(offeringId);

      expect(result).toHaveLength(0);
    });
  });
});
