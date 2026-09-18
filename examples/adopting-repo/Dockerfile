FROM oven/bun:1.4.0
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN bun install

COPY . .
RUN chmod +x docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
