// Integration tests: need a TinkerPop Gremlin Server (see docker-compose.yml, profile "gremlin").
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.int.test.ts'],
  transform: { '^.+\\.tsx?$': ['@swc/jest'] },
  testTimeout: 30000,
};
