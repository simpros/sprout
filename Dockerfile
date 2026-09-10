FROM oven/bun:1.4.0
ARG SPROUT_VERSION=0.4.1
LABEL org.opencontainers.image.title="sprout"
LABEL org.opencontainers.image.description="CI-driven preview gateway (preview-db + app-deployment)"
LABEL org.opencontainers.image.version="${SPROUT_VERSION}"
WORKDIR /app

COPY package.json bun.lock bunfig.toml turbo.json tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY packages/preview-env/package.json packages/preview-env/
COPY packages/preview-db/package.json packages/preview-db/
COPY packages/api-client/package.json packages/api-client/

RUN bun install --frozen-lockfile

COPY apps/server apps/server
COPY apps/cli apps/cli
COPY packages/preview-env packages/preview-env
COPY packages/preview-db packages/preview-db
COPY packages/api-client packages/api-client

# Operator exec path: `docker exec <gateway> sprout …` against localhost.
# Same wrapper shape as examples/adopting-repo CI (exec bun …/index.ts).
RUN printf '%s\n' '#!/usr/bin/env bash' \
  'exec bun /app/apps/cli/src/index.ts "$@"' \
  > /usr/local/bin/sprout \
  && chmod +x /usr/local/bin/sprout

WORKDIR /app/apps/server
ENV SPROUT_STATE_DB_PATH=/data/sprout.db
ENV SPROUT_ADMIN_TOKEN_PATH=/data/admin-token
EXPOSE 7331
CMD ["bun", "run", "start"]
