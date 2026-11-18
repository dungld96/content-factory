# syntax=docker/dockerfile:1
# One image for the API, worker, web and the database/CLI tools (ADR-0014). Staging only.
FROM node:22.23.4-bookworm-slim

ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate && chmod -R a+rX /opt/corepack \
 && mkdir /app && chown node:node /app

WORKDIR /app
COPY --chown=node:node . .
USER node
# Small VMs: give the TypeScript and Next.js builds enough heap (add swap on 2-4 GB machines).
RUN pnpm install --frozen-lockfile \
 && NODE_OPTIONS=--max-old-space-size=3072 pnpm build

ENV NODE_ENV=production
# Each compose service sets its own working directory and command.
CMD ["node", "--version"]
