const path = require('path');

// Without a generated Prisma client (`prisma generate` needs
// binaries.prisma.sh, blocked in some sandboxes), importing PrismaService
// fails both at runtime and in type-checking. The unit specs only use
// mocked Prisma objects, so in that situation — and only that situation —
// stub `@prisma/client` and skip ts-jest's type diagnostics. With a real
// generated client, tests run exactly as before, fully type-checked.
function hasGeneratedPrismaClient() {
  try {
    const clientDir = path.dirname(require.resolve('@prisma/client'));
    require.resolve('.prisma/client/default', { paths: [clientDir] });
    return true;
  } catch {
    return false;
  }
}
const stubPrisma = !hasGeneratedPrismaClient();

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '(?<!integration\\.)spec\\.ts$', // unit tests only — no DB/network required
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', stubPrisma ? { diagnostics: false } : {}],
  },
  moduleNameMapper: stubPrisma ? { '^@prisma/client$': path.join(__dirname, 'test/prisma-client-stub.js') } : {},
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  testTimeout: 20_000, // argon2 hashing is deliberately slow (see PasswordService)
};
