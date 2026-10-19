# ==============================================================================
# Showwork Functions / Standalone BullMQ Worker - Bun Dockerfile
# ==============================================================================
FROM oven/bun:1-debian AS builder
WORKDIR /app

# Install system dependencies required for building native bindings and Prisma
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package definitions and Prisma schema
COPY package.json package-lock.json* bun.lockb* ./
COPY prisma ./prisma/

# Install dependencies (including devDependencies required for Prisma generation & esbuild)
RUN bun install

# Generate Prisma Client for Debian Linux
RUN bunx prisma generate

# Copy source code and build config
COPY tsconfig*.json ./
COPY lib ./lib
COPY workers ./workers
COPY scripts ./scripts
COPY types ./types

# Build the standalone worker bundle
RUN bun run worker:bullmq:build

# ==============================================================================
# Production Runner Stage
# ==============================================================================
FROM oven/bun:1-debian AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install runtime system packages: openssl (Prisma engine), ca-certificates (HTTPS/APIs), ffmpeg (media processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and Prisma schema
COPY package.json package-lock.json* bun.lockb* ./
COPY prisma ./prisma/

# Install production dependencies
RUN bun install

# Copy generated Prisma engine/client and compiled worker bundle from builder
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist-worker-native ./dist-worker-native

# Use non-root bun user
RUN chown -R bun:bun /app
USER bun

# Healthcheck to verify connectivity to Redis and PostgreSQL
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD bun run dist-worker-native/run-bullmq.cjs --check || exit 1

# Run prestart (e.g. database schema sync/pull) before starting the BullMQ worker
CMD ["sh", "-c", "bun run prestart && bun run dist-worker-native/run-bullmq.cjs --run"]
