// eslint-disable-next-line
module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/test/e2e'],
  preset: 'ts-jest',
  transform: {
    '^.+\\.ts?$': 'ts-jest',
  },
  transformIgnorePatterns: ['<rootDir>/node_modules/'],
  testEnvironment: 'node',
  testMatch: ['**/*.e2e.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  clearMocks: true,
  errorOnDeprecated: true,
  setupFilesAfterEnv: [],
  testTimeout: 60000,
}