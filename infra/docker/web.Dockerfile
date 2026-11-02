# Development image only — not a production build.
FROM node:20-alpine

WORKDIR /app
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages ./packages

RUN corepack enable && pnpm install --frozen-lockfile || pnpm install

COPY apps/web apps/web

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "dev"]
