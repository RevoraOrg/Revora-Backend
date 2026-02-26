"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogoutRouter = void 0;
const express_1 = require("express");
const logoutHandler_1 = require("./logoutHandler");
const logoutService_1 = require("./logoutService");
const createLogoutRouter = ({ requireAuth, sessionRepository, }) => {
    const router = (0, express_1.Router)();
    const logoutService = new logoutService_1.LogoutService(sessionRepository);
    router.post('/api/auth/logout', requireAuth, (0, logoutHandler_1.createLogoutHandler)(logoutService));
    return router;
};
exports.createLogoutRouter = createLogoutRouter;
