FROM oven/bun:1.4.0
WORKDIR /app

COPY package.json bun.lock bunfig.toml turbo.json tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json apps/server/

RUN bun install --frozen-lockfile

COPY apps/server apps/server

WORKDIR /app/apps/server
ENV PB_STATE_DB_PATH=/data/preview-buddy.db
EXPOSE 7331
CMD ["bun", "run", "start"]
