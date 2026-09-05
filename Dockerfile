# Multi-stage build producing a self-contained runtime image.
#
# The final stage carries the Next.js standalone bundle plus the SQL migration
# files, and nothing else — no node_modules, no source, no build toolchain.
# Migrations run at boot from instrumentation.ts, so the container needs no
# entrypoint script and no "remember to run the migration" step in a runbook.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    BUILD_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# A build must never depend on a reachable database: nothing here connects,
# because the pool is created lazily on first query.
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as a non-root user. The image writes nothing outside /tmp.
RUN addgroup -g 1001 -S nodejs && adduser -S tidemark -u 1001

COPY --from=build --chown=tidemark:nodejs /app/.next/standalone ./
COPY --from=build --chown=tidemark:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=tidemark:nodejs /app/public ./public
# The migrator reads these at boot.
COPY --from=build --chown=tidemark:nodejs /app/db ./db

USER tidemark
EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=4s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
