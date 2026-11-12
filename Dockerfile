# Agentic Treasury gateway and isolated Treasury executors in one container.
# Secrets come from the host environment and the volume, never from this image.
FROM node:24.22.2-slim

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Verified local consumer SDK; replace its alias with a published exact pin before release.
COPY vendor/multiagency-sdk-0.5.8.tgz ./vendor/multiagency-sdk-0.5.8.tgz
COPY vendor/multiagency-sdk-0.5.8.tgz.sha256 ./vendor/multiagency-sdk-0.5.8.tgz.sha256
RUN cd vendor && sha256sum --check multiagency-sdk-0.5.8.tgz.sha256
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY shared ./shared
COPY src ./src
COPY web ./web
# The focused build serves the Treasury skill at /skill.md.
COPY skills ./skills
COPY evidence ./evidence
ARG PUBLIC_TREASURY_ONLY=true
RUN pnpm build:web
COPY deploy ./deploy

# All state lives on the volume mounted at /data (see deploy/dashboard-entrypoint.sh). One replica only:
# no other host may execute for the treasury agent.
ENV NODE_ENV=production DASHBOARD_FILE=/app/deploy/treasury.json TRUST_PROXY=true
EXPOSE 8080
CMD ["/app/deploy/dashboard-entrypoint.sh"]
