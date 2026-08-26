# LumiCore unified client/server image. Organization workspaces live inside the same deployment.
# Build:  docker build -t lumicore .
# Run:    docker run -p 3000:3000 -e JWT_SECRET=xxx lumicore

# ── Build stage ──────────────────────────────────────────────────────────
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install

COPY . .
RUN npm run build && npm run build:server

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Only runtime deps
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/dist-server /app/dist-server

# data/ is a volume — created at runtime by the app if not mounted
RUN mkdir -p /app/data

WORKDIR /app/dist-server

EXPOSE 3000

ENV NODE_ENV=production

# Health check pings the Express health endpoint
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "entry.cjs"]
