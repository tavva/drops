FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm exec tsx src/index.ts"]
