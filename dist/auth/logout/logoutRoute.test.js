"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const logoutHandler_1 = require("./logoutHandler");
const logoutService_1 = require("./logoutService");
class InMemorySessionRepository {
    constructor(tokenToSession = new Map()) {
        this.tokenToSession = tokenToSession;
    }
    add(token, sessionId) {
        this.tokenToSession.set(token, sessionId);
    }
    getSessionId(token) {
        return this.tokenToSession.get(token);
    }
    async deleteSessionById(sessionId) {
        for (const [token, storedSessionId] of this.tokenToSession.entries()) {
            if (storedSessionId === sessionId) {
                this.tokenToSession.delete(token);
                return;
            }
        }
    }
}
class MockResponse {
    constructor() {
        this.statusCode = 200;
    }
    status(code) {
        this.statusCode = code;
        return this;
    }
    json(payload) {
        this.payload = payload;
        return this;
    }
    send(payload) {
        this.payload = payload;
        return this;
    }
}
const createBearerHeader = (token) => `Bearer ${token}`;
const createProtectedAuthMiddleware = (sessions) => {
    return (req, res, next) => {
        const bearer = req.headers.authorization;
        const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
        if (!token) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        const sessionId = sessions.getSessionId(token);
        if (!sessionId) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        req.auth = {
            userId: 'user-1',
            sessionId,
            tokenId: token,
        };
        next();
    };
};
const login = (sessions) => {
    const token = 'jwt-token-1';
    sessions.add(token, 'session-1');
    return token;
};
(0, node_test_1.default)('logout invalidates current session and token can no longer be used', async () => {
    const sessions = new InMemorySessionRepository();
    const requireAuth = createProtectedAuthMiddleware(sessions);
    const logoutHandler = (0, logoutHandler_1.createLogoutHandler)(new logoutService_1.LogoutService(sessions));
    const token = login(sessions);
    const authorizedRequestBeforeLogout = {
        headers: { authorization: createBearerHeader(token) },
    };
    const authorizedResponseBeforeLogout = new MockResponse();
    let nextCalledBeforeLogout = false;
    requireAuth(authorizedRequestBeforeLogout, authorizedResponseBeforeLogout, () => {
        nextCalledBeforeLogout = true;
    });
    strict_1.default.equal(nextCalledBeforeLogout, true);
    strict_1.default.equal(authorizedRequestBeforeLogout.auth?.sessionId, 'session-1');
    const logoutResponse = new MockResponse();
    await logoutHandler(authorizedRequestBeforeLogout, logoutResponse, () => undefined);
    strict_1.default.equal(logoutResponse.statusCode, 204);
    const authorizedRequestAfterLogout = {
        headers: { authorization: createBearerHeader(token) },
    };
    const unauthorizedResponseAfterLogout = new MockResponse();
    let nextCalledAfterLogout = false;
    requireAuth(authorizedRequestAfterLogout, unauthorizedResponseAfterLogout, () => {
        nextCalledAfterLogout = true;
    });
    strict_1.default.equal(nextCalledAfterLogout, false);
    strict_1.default.equal(unauthorizedResponseAfterLogout.statusCode, 401);
});
