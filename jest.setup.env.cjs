// Jest runs test files in arbitrary order. Many suites import modules that read
// `process.env.JWT_SECRET` at runtime; ensure a valid default exists unless
// the suite intentionally manages the env var itself.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET =
    "test-secret-key-that-is-at-least-32-characters-long!";
}
