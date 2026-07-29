import { PactV3 } from '@pact-foundation/pact';
import * as http from 'http';

const U1 = '550e8400-e29b-41d4-a716-446655440000';
const N1 = '550e8400-e29b-41d4-a716-446655440002';
const N2 = '550e8400-e29b-41d4-a716-446655440003';
const NX = '550e8400-e29b-41d4-a716-446655440005';

const NOTIFICATION_RESPONSE_BODY = {
  notifications: [
    {
      id: N1,
      user_id: U1,
      type: 'info',
      message: 'm1',
      read: false,
      created_at: '2024-01-10T00:00:00.000Z',
    },
    {
      id: N2,
      user_id: U1,
      type: 'alert',
      message: 'm2',
      read: false,
      created_at: '2024-01-11T00:00:00.000Z',
    },
  ],
};

const EMPTY_NOTIFICATIONS_BODY = {
  notifications: [],
};

describe('Notifications API Consumer Pact', () => {
  describe('GET /notifications', () => {
    it('returns notifications for an authenticated user', async () => {
      const pact = new PactV3({
        consumer: 'revora-consumer',
        provider: 'revora-backend',
        dir: 'pacts/notifications',
      });

      await pact
        .given('user has notifications')
        .uponReceiving('a request to list notifications for a user with notifications')
        .withRequest({
          method: 'GET',
          path: '/notifications',
          headers: { Authorization: 'Bearer test-token' },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: NOTIFICATION_RESPONSE_BODY,
        })
        .executeTest(async (mockServer) => {
          const res = await new Promise<any>((resolve, reject) => {
            http
              .get(
                `${mockServer.url}/notifications`,
                { headers: { Authorization: 'Bearer test-token' } },
                (response) => {
                  let body = '';
                  response.on('data', (chunk) => (body += chunk));
                  response.on('end', () =>
                    resolve({ status: response.statusCode, body: JSON.parse(body) }),
                  );
                },
              )
              .on('error', reject);
          });

          expect(res.status).toBe(200);
          expect(res.body).toEqual(NOTIFICATION_RESPONSE_BODY);
        });
    });

    it('returns empty list when user has no notifications', async () => {
      const pact = new PactV3({
        consumer: 'revora-consumer',
        provider: 'revora-backend',
        dir: 'pacts/notifications',
      });

      await pact
        .given('user has no notifications')
        .uponReceiving('a request to list notifications when user has none')
        .withRequest({
          method: 'GET',
          path: '/notifications',
          headers: { Authorization: 'Bearer test-token' },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: EMPTY_NOTIFICATIONS_BODY,
        })
        .executeTest(async (mockServer) => {
          const res = await new Promise<any>((resolve, reject) => {
            http
              .get(
                `${mockServer.url}/notifications`,
                { headers: { Authorization: 'Bearer test-token' } },
                (response) => {
                  let body = '';
                  response.on('data', (chunk) => (body += chunk));
                  response.on('end', () =>
                    resolve({ status: response.statusCode, body: JSON.parse(body) }),
                  );
                },
              )
              .on('error', reject);
          });

          expect(res.status).toBe(200);
          expect(res.body).toEqual(EMPTY_NOTIFICATIONS_BODY);
        });
    });

    it('returns 401 when no auth token is provided', async () => {
      const pact = new PactV3({
        consumer: 'revora-consumer',
        provider: 'revora-backend',
        dir: 'pacts/notifications',
      });

      await pact
        .uponReceiving('an unauthorized request to list notifications')
        .withRequest({
          method: 'GET',
          path: '/notifications',
        })
        .willRespondWith({
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        })
        .executeTest(async (mockServer) => {
          const res = await new Promise<any>((resolve, reject) => {
            http
              .get(`${mockServer.url}/notifications`, (response) => {
                let body = '';
                response.on('data', (chunk) => (body += chunk));
                response.on('end', () =>
                  resolve({ status: response.statusCode, body: JSON.parse(body) }),
                );
              })
              .on('error', reject);
          });

          expect(res.status).toBe(401);
        });
    });
  });

  describe('PATCH /notifications/:id/read', () => {
    it('marks a notification as read', async () => {
      const pact = new PactV3({
        consumer: 'revora-consumer',
        provider: 'revora-backend',
        dir: 'pacts/notifications',
      });

      await pact
        .given('a notification exists')
        .uponReceiving('a request to mark a notification as read')
        .withRequest({
          method: 'PATCH',
          path: `/notifications/${N1}/read`,
          headers: {
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          },
          body: {},
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: { marked: 1 },
        })
        .executeTest(async (mockServer) => {
          const data = JSON.stringify({});
          const res = await new Promise<any>((resolve, reject) => {
            const req = http.request(
              `${mockServer.url}/notifications/${N1}/read`,
              {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer test-token',
                },
              },
              (response) => {
                let body = '';
                response.on('data', (chunk) => (body += chunk));
                response.on('end', () =>
                  resolve({ status: response.statusCode, body: JSON.parse(body) }),
                );
              },
            );
            req.on('error', reject);
            req.write(data);
            req.end();
          });

          expect(res.status).toBe(200);
          expect(res.body).toEqual({ marked: 1 });
        });
    });

    it('returns 404 when notification does not exist', async () => {
      const pact = new PactV3({
        consumer: 'revora-consumer',
        provider: 'revora-backend',
        dir: 'pacts/notifications',
      });

      await pact
        .given('notification does not exist')
        .uponReceiving('a request to mark a notification that does not exist')
        .withRequest({
          method: 'PATCH',
          path: `/notifications/${NX}/read`,
          headers: {
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          },
          body: {},
        })
        .willRespondWith({
          status: 404,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: { code: 'NOT_FOUND', message: 'Notification not found' },
        })
        .executeTest(async (mockServer) => {
          const data = JSON.stringify({});
          const res = await new Promise<any>((resolve, reject) => {
            const req = http.request(
              `${mockServer.url}/notifications/${NX}/read`,
              {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer test-token',
                },
              },
              (response) => {
                let body = '';
                response.on('data', (chunk) => (body += chunk));
                response.on('end', () =>
                  resolve({ status: response.statusCode, body: JSON.parse(body) }),
                );
              },
            );
            req.on('error', reject);
            req.write(data);
            req.end();
          });

          expect(res.status).toBe(404);
        });
    });

    it('returns 401 when no auth token is provided', async () => {
      const pact = new PactV3({
        consumer: 'revora-consumer',
        provider: 'revora-backend',
        dir: 'pacts/notifications',
      });

      await pact
        .uponReceiving('an unauthorized request to mark a notification as read')
        .withRequest({
          method: 'PATCH',
          path: `/notifications/${N1}/read`,
          headers: { 'Content-Type': 'application/json' },
          body: {},
        })
        .willRespondWith({
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        })
        .executeTest(async (mockServer) => {
          const data = JSON.stringify({});
          const res = await new Promise<any>((resolve, reject) => {
            const req = http.request(
              `${mockServer.url}/notifications/${N1}/read`,
              {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                },
              },
              (response) => {
                let body = '';
                response.on('data', (chunk) => (body += chunk));
                response.on('end', () =>
                  resolve({ status: response.statusCode, body: JSON.parse(body) }),
                );
              },
            );
            req.on('error', reject);
            req.write(data);
            req.end();
          });

          expect(res.status).toBe(401);
        });
    });
  });
});
