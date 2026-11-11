# Treasury owner app only. The compatible platform is a separate deployment.
FROM node:24.22.2-slim AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor/multiagency-sdk-0.5.8.tgz vendor/multiagency-sdk-0.5.8.tgz.sha256 ./vendor/
# Verify the frozen consumer SDK before the package manager reads it.
RUN cd vendor && sha256sum --check multiagency-sdk-0.5.8.tgz.sha256
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY app ./app
COPY shared ./shared
COPY src ./src
COPY web ./web
COPY skills ./skills
COPY evidence ./evidence
RUN pnpm build:web

FROM node:24.22.2-slim AS runtime

WORKDIR /app
COPY --from=build /app/package.json /app/tsconfig.json ./
# tsx and the app SDK are needed at runtime even though this repository lists them as dev dependencies.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/app ./app
COPY --from=build /app/shared ./shared
# DAO membership reads import policy's asset constants; its executor import is type-only.
COPY --from=build /app/src/chain.ts /app/src/policy.ts ./src/
COPY --from=build /app/web/dist ./web/dist
COPY deploy/app-entrypoint.sh ./deploy/app-entrypoint.sh
COPY scripts/treasury-app-preflight.mjs ./scripts/treasury-app-preflight.mjs
RUN chmod 755 /app/deploy/app-entrypoint.sh

# Attach the app service's own persistent volume at /data. Its claims must survive every restart.
ENV NODE_ENV=production APP_STATE=/data/app APP_WEB_DIST=/app/web/dist PORT=8080 TRUST_PROXY=true
EXPOSE 8080
CMD ["/app/deploy/app-entrypoint.sh"]
