# Imagem do serviço: o mesmo artefato roda a API e, como comando avulso, as
# migrations (serviço `migrate` do Compose).
FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV PORT=3000
EXPOSE 3000
USER bun

CMD ["bun", "src/main.ts"]
