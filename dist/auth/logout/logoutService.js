"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogoutService = void 0;
class LogoutService {
    constructor(sessionRepository) {
        this.sessionRepository = sessionRepository;
    }
    async logout(sessionId) {
        await this.sessionRepository.deleteSessionById(sessionId);
    }
}
exports.LogoutService = LogoutService;
