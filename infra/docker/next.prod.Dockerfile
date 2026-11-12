# Production image for a Next.js app (web or admin) using standalone output.
# NEXT_PUBLIC_API_URL is inlined at BUILD time, so it is a build argument:
#   docker build -f infra/docker/next.prod.Dockerfile \
#     --build-arg APP=admin --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t cbp-admin .
FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG APP
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_STANDALONE=true NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/${APP}/package.json apps/${APP}/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @cbp/${APP}...
COPY apps/${APP} apps/${APP}
RUN pnpm --filter @cbp/${APP} build

FROM base AS runtime
ARG APP
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP=${APP} PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/${APP}/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/${APP}/.next/static ./apps/${APP}/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node apps/${APP}/server.js"]
