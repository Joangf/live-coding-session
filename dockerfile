FROM oven/bun:canary-alpine

WORKDIR /app

COPY package.json .
COPY bun.lock .

RUN bun install --production

COPY src ./src
EXPOSE 3000
CMD ["bun", "start"]