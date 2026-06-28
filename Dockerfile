FROM node:22-bookworm-slim AS app

WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json vite.config.ts vitest.config.ts eslint.config.js ./
COPY src ./src
COPY README.md ./

RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start:worker"]
