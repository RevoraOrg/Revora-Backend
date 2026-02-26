import assert from 'node:assert/strict';
import test from 'node:test';
import { Request, Response } from 'express';
import router, { overviewHandler } from './overview';

class MockResponse {
    statusCode = 200;
    payload: unknown;

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    json(payload: unknown): this {
        this.payload = payload;
        return this;
    }
}

test('overviewHandler returns correct metadata', async () => {
    const req = {} as Request;
    const res = new MockResponse();

    await overviewHandler(req, res as unknown as Response);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.payload, {
        name: 'Stellar RevenueShare (Revora) Backend',
        description:
            'Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).',
        version: '0.1.0'
    });
});

// Refactoring overview.ts to export the handler for easier testing
