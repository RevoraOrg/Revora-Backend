import { Request, Response, NextFunction } from 'express';

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        role: 'issuer' | 'investor' | 'admin';
    };
}

/**
 * Mock authentication middleware.
 * In a real application, this would verify a JWT or session.
 * For this task, we assume the issuer ID is provided in the 'X-Issuer-Id' header.
 */
export const authMiddleware = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) => {
    const issuerId = req.header('X-Issuer-Id');

    if (!issuerId) {
        return res.status(401).json({ error: 'Unauthorized: Missing Issuer ID' });
    }

    // Simulate user object injection
    req.user = {
        id: issuerId,
        role: 'issuer', // For this task, we simulate the issuer role
    };

    next();
};
