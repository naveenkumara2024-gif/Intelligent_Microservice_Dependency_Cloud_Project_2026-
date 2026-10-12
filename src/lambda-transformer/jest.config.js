module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // Unit tests only; integration tests (need a Gremlin Server) are *.int.test.ts, run by `npm run test:integration`.
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.int\\.test\\.ts$'],
  transform: { '^.+\\.tsx?$': ['@swc/jest'] },
};
