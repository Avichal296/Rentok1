FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @rentok/api db:generate && pnpm --filter @rentok/api build
EXPOSE 4000
CMD ["sh", "-c", "pnpm --filter @rentok/api db:deploy && pnpm --filter @rentok/api start"]
