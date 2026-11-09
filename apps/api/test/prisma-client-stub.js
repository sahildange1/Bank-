// Used ONLY by jest.config.js when no generated Prisma client exists (e.g.
// a sandbox where binaries.prisma.sh is blocked). Unit specs inject mocked
// Prisma objects, so they only need `PrismaClient` to exist as a base class.
class PrismaClient {}
module.exports = { PrismaClient, Prisma: {} };
