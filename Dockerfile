FROM oven/bun:1.4.0
ARG SPROUT_VERSION=0.2.1
LABEL org.opencontainers.image.title="sprout"
LABEL org.opencontainers.image.description="CI-driven preview gateway (preview-db + app-deployment)"
LABEL org.opencontainers.image.version="${SPROUT_VERSION}"
WORKDIR /app

COPY package.json bun.lock bunfig.toml turbo.json tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY packages/preview-env/package.json packages/preview-env/

RUN bun install --frozen-lockfile

COPY apps/server apps/server
COPY packages/preview-env packages/preview-env

WORKDIR /app/apps/server
ENV SPROUT_STATE_DB_PATH=/data/sprout.db
EXPOSE 7331
CMD ["bun", "run", "start"]
