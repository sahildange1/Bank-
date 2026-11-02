// Integration tests: require a live Postgres (DATABASE_URL) and a real,
// generated Prisma client. Run separately from the unit suite:
//   DATABASE_URL=... npx jest --config jest.integration.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '\\.integration\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  testTimeout: 30_000,
};
