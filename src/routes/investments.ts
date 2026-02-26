import {Request, Response, Router, RequestHandler} from "express";
import {InvestmentService} from "../services/investmentService";
import {AuthenticatedRequest} from "../auth/logout/types";

/**
 * Request body for creating an investment
 */
export interface CreateInvestmentBody {
  offering_id: string;
  amount: string;
  transaction_hash?: string;
}

/**
 * Dependencies for creating the investments router
 */
interface CreateInvestmentsRouterDeps {
  requireAuth: RequestHandler;
  investmentService: InvestmentService;
}

/**
 * Creates the request handler for creating an investment
 * @param investmentService The investment service
 * @returns Request handler function
 */
export const createInvestmentHandler = (
  investmentService: InvestmentService,
): RequestHandler => {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const body = req.body as CreateInvestmentBody;
      const {offering_id, amount, transaction_hash} = body;

      // Validate required fields
      if (!offering_id) {
        res.status(400).json({error: "offering_id is required"});
        return;
      }

      if (!amount) {
        res.status(400).json({error: "amount is required"});
        return;
      }

      // Get investor ID from auth context
      const investorId = req.auth?.userId;
      if (!investorId) {
        res.status(401).json({error: "Unauthorized"});
        return;
      }

      // Create the investment
      const investment = await investmentService.createInvestment({
        offering_id,
        investor_id: investorId,
        amount,
        transaction_hash,
      });

      // Return 201 Created with the investment record
      res.status(201).json({
        id: investment.id,
        offering_id: investment.offering_id,
        investor_id: investment.investor_id,
        amount: investment.amount,
        status: investment.status,
        transaction_hash: investment.transaction_hash,
        created_at: investment.created_at,
      });
    } catch (error) {
      // Handle known error types
      if (error instanceof Error) {
        if (error.name === "OfferingNotFoundError") {
          res.status(404).json({error: error.message});
          return;
        }
        if (error.name === "OfferingClosedError") {
          res.status(400).json({error: error.message});
          return;
        }
        if (error.name === "InvalidInvestmentAmountError") {
          res.status(400).json({error: error.message});
          return;
        }
      }

      // Re-throw unknown errors to be handled by Express error handler
      throw error;
    }
  };
};

/**
 * Creates the investments router
 * @param deps Dependencies including auth middleware and investment service
 * @returns Configured Express router
 */
export const createInvestmentsRouter = ({
  requireAuth,
  investmentService,
}: CreateInvestmentsRouterDeps): Router => {
  const router = Router();

  // POST /api/investments - Create a new investment
  router.post(
    "/api/investments",
    requireAuth,
    createInvestmentHandler(investmentService),
  );

  return router;
};
