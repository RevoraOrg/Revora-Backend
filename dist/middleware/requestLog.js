"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogMiddleware = requestLogMiddleware;
const crypto_1 = require("crypto");
// Sensitive actions that should be audited
const SENSITIVE_ACTIONS = [
    { method: 'POST', pathPattern: /^\/auth\/login$/ },
    { method: 'POST', pathPattern: /^\/offerings$/ },
    { method: 'POST', pathPattern: /^\/invest$/ },
    { method: 'POST', pathPattern: /^\/revenue$/ },
];
/**
 * Middleware for logging API requests and auditing sensitive actions
 */
function requestLogMiddleware() {
    return (req, res, next) => {
        const requestId = (0, crypto_1.randomUUID)();
        const startTime = process.hrtime.bigint();
        // Add requestId to request for potential use in routes
        req.requestId = requestId;
        // Log the incoming request
        const incomingLog = {
            requestId,
            method: req.method,
            path: req.path,
            userId: req.user?.id, // Assuming user is set by auth middleware
            timestamp: new Date().toISOString(),
        };
        console.log(JSON.stringify({ type: 'request_start', ...incomingLog }));
        // Override res.end to log after response
        const originalEnd = res.end;
        res.end = function (chunk, encoding) {
            const endTime = process.hrtime.bigint();
            const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
            const log = {
                requestId,
                method: req.method,
                path: req.path,
                userId: req.user?.id,
                status: res.statusCode,
                duration: Math.round(duration * 100) / 100, // Round to 2 decimal places
                timestamp: new Date().toISOString(),
            };
            console.log(JSON.stringify({ type: 'request_end', ...log }));
            // Check if this is a sensitive action
            const isSensitive = SENSITIVE_ACTIONS.some((action) => action.method === req.method && action.pathPattern.test(req.path));
            if (isSensitive) {
                const auditLog = {
                    requestId,
                    userId: req.user?.id,
                    action: getActionFromPath(req.method, req.path),
                    resource: req.path,
                    ipAddress: req.ip,
                    userAgent: req.get('User-Agent'),
                    timestamp: new Date().toISOString(),
                };
                console.log(JSON.stringify({ type: 'audit', ...auditLog }));
                // Note: Persistence to database would be done here if auditRepository was available
                // For now, just logging to console as per requirements
            }
            // Call original end
            originalEnd.call(this, chunk, encoding);
        };
        next();
    };
}
function getActionFromPath(method, path) {
    if (method === 'POST' && path === '/auth/login')
        return 'login';
    if (method === 'POST' && path === '/offerings')
        return 'create_offering';
    if (method === 'POST' && path === '/invest')
        return 'invest';
    if (method === 'POST' && path === '/revenue')
        return 'report_revenue';
    return 'unknown';
}
