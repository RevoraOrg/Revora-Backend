"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const app = (0, express_1.default)();
const port = process.env.PORT ?? 4000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((0, morgan_1.default)('dev'));
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'revora-backend' });
});
app.get('/api/overview', (_req, res) => {
    res.json({
        name: 'Stellar RevenueShare (Revora) Backend',
        description: 'Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).'
    });
});
app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`revora-backend listening on http://localhost:${port}`);
});
