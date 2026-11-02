# Development image only — not a production build.
FROM node:20-alpine

WORKDIR /app
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages ./packages

RUN corepack enable && pnpm install --frozen-lockfile || pnpm install

COPY apps/api apps/api

WORKDIR /app/apps/api
EXPOSE 4000
CMD ["pnpm", "dev"]
