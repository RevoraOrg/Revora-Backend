import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 }, // ramp up to 20 users
    { duration: '1m', target: 20 },  // stay at 20 users
    { duration: '30s', target: 0 },  // ramp down to 0
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests must complete below 500ms
    http_req_failed: ['rate<0.01'],   // error rate must be less than 1%
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  // Scenario 1: GET health
  const healthRes = http.get(`${BASE_URL}/health/ready`);
  check(healthRes, {
    'health status is 200': (r) => r.status === 200,
    'health response has ok': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status === 'ok';
      } catch (e) {
        return false;
      }
    },
  });

  // Scenario 2: GET public offerings
  const offeringsRes = http.get(`${BASE_URL}/api/offerings`);
  check(offeringsRes, {
    'offerings status is 200': (r) => r.status === 200,
    'offerings response is valid': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.offerings);
      } catch (e) {
        return false;
      }
    },
  });

  sleep(1);
}
