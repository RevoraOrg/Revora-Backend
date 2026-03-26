const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/jest.setup.env.cjs"],
  transform: {
    ...tsJestTransformCfg,
  },
  // Prevent picking up compiled tests emitted to `dist/` by `tsc`.
  testPathIgnorePatterns: ["<rootDir>/dist/", "/node_modules/"],
};