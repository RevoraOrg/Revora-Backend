import { WebhookQueue } from './index';

describe('WebhookQueue - Backend-028', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(global, 'setTimeout');
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('isSafeUrl should block SSRF attempts', () => {
        // Accessing private method for coverage
        const isSafe = (WebhookQueue as any).isSafeUrl;
        expect(isSafe('http://127.0.0.1')).toBe(false);
        expect(isSafe('http://localhost')).toBe(false);
        expect(isSafe('http://192.168.1.50')).toBe(false); // Correctly identified as internal/unsafe   
        expect(isSafe('https://google.com')).toBe(true);
    });

    test('processDelivery should retry exponentially and eventually fail', async () => {
        const url = 'https://api.stellar.org/webhook';
        const payload = { event: 'test' };

        const deliveryPromise = WebhookQueue.processDelivery(url, payload);

        // Fast-forward through 5 retries
        for (let i = 0; i < 6; i++) {
            jest.runAllTimers();
            await Promise.resolve(); 
        }

        const result = await deliveryPromise;
        expect(result).toBe(false); // Should fail after MAX_RETRIES
        expect(setTimeout).toHaveBeenCalledTimes(5);
    });

    test('getBackoffDelay returns -1 after max retries', () => {
        expect(WebhookQueue.getBackoffDelay(0)).toBe(1000);
        expect(WebhookQueue.getBackoffDelay(5)).toBe(-1);
    });

    test('isSafeUrl should return false for malformed URLs', () => {
    const isSafe = (WebhookQueue as any).isSafeUrl;
    expect(isSafe('not-a-valid-url')).toBe(false);
});
});