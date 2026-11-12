# Production image for the API and the worker (same image, different command).
# Targets:
#   api    (default) lean runtime: prod deps + compiled output, non-root
#   tools  full toolchain (ts-node) for one-off jobs: seed, create-platform-operator
#
# Build:  docker build -f infra/docker/api.prod.Dockerfile -t cbp-api .
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @cbp/api...
COPY apps/api apps/api
RUN pnpm --filter @cbp/api exec prisma generate && pnpm --filter @cbp/api build

# One-off administrative jobs (seed, bootstrap a platform operator).
FROM build AS tools
WORKDIR /app/apps/api
USER node
CMD ["node", "-e", "console.log('use: pnpm prisma:seed | ts-node prisma/create-platform-operator.ts')"]

FROM build AS prod-deps
RUN pnpm --filter @cbp/api deploy --prod /out \
    && cd /out && ./node_modules/.bin/prisma generate

FROM base AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./prisma
COPY --from=build --chown=node:node /app/apps/api/package.json ./package.json
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
