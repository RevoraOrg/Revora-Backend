"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogoutHandler = void 0;
const createLogoutHandler = (logoutService) => {
    return async (req, res, next) => {
        try {
            const sessionId = req.auth?.sessionId;
            if (!sessionId) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
            await logoutService.logout(sessionId);
            res.status(204).send();
        }
        catch (error) {
            next(error);
        }
    };
};
exports.createLogoutHandler = createLogoutHandler;
