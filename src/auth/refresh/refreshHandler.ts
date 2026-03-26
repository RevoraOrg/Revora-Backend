import { NextFunction, Request, RequestHandler, Response } from 'express';
import { RefreshService } from './refreshService';

/**
 * Express handler factory for `POST /api/auth/refresh`.
 *
 * Validates the refresh token, delegates to `RefreshService`, and returns
 * new access/refresh tokens.
 */
export const createRefreshHandler = (
    refreshService: RefreshService,
): RequestHandler => {
    return async (
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const { refreshToken } = req.body ?? {};

            if (!refreshToken) {
                res.status(400).json({
                    error: 'Bad Request',
                    message: '"refreshToken" is required.',
                });
                return;
            }

            const result = await refreshService.refresh(refreshToken);

            if (!result) {
                res.status(401).json({ error: 'Invalid or expired refresh token' });
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            next(error);
        }
    };
};
