# ---- Single-container Turnstile solver: WS hub + HTTP API + Chrome workers ----
# Node >= 22 provides the global WebSocket the worker processes use.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        ca-certificates \
        xvfb \
        xauth \
        dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Wrapper: run Chrome through Xvfb so the workers' "visible" fallback browser
# (used when Cloudflare challenges the headless fingerprint) works without a
# real display. Headless browsers pass through unchanged. The container runs
# as root, so CHROME_ARGS_EXTRA must include --no-sandbox (set in Railway /
# docker-compose.yml).
RUN printf '#!/bin/sh\nexec xvfb-run -a /usr/bin/chromium "$@"\n' > /usr/local/bin/solver-chrome \
    && chmod +x /usr/local/bin/solver-chrome

WORKDIR /app
WORKDIR /app
ENV NODE_ENV=production
# Safe defaults for this image (it runs as root): --no-sandbox is mandatory for
# Chromium as root, --disable-dev-shm-usage avoids small /dev/shm. Deploy-time
# service variables (Railway) override this ENV if a custom value is wanted.
ENV CHROME_ARGS_EXTRA=--no-sandbox,--disable-dev-shm-usage,--disable-gpu

ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY server.mjs solver.mjs ./

# Solver state (worker JSON, Chrome profiles) lives here; mount a volume to persist.
RUN mkdir -p /app/.state
VOLUME ["/app/.state"]

# Railway injects PORT automatically; server.mjs binds it.
EXPOSE 8082
CMD ["dumb-init", "node", "server.mjs"]
