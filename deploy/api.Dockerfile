FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @reviewr/shared build && pnpm --filter @reviewr/api build
WORKDIR /app/apps/api
CMD ["pnpm", "start"]
