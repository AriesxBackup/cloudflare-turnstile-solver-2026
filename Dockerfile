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

# Wrapper: run Chrome through a SINGLE persistent Xvfb (:99) so the workers'
# "visible" fallback browser works without a real display, and every relaunch
# reconnects to the same healthy display instead of spinning up yet another
# Xvfb under memory pressure (per-launch `xvfb-run -a` made Chromium hit fatal
# startup errors / SIGTRAP (exit 133) when many instances raced at once). The
# container runs as root, so CHROME_ARGS_EXTRA must include --no-sandbox (set
# in Railway / docker-compose.yml).
RUN printf '%s\n' \
    '#!/bin/sh' \
    '# Persistent shared Xvfb on :99. Reused by every (re)launched Chrome.' \
    'if [ -e /tmp/.X11-unix/X99 ] && [ -f /tmp/xvfb.pid ] && kill -0 "$(cat /tmp/xvfb.pid)" 2>/dev/null; then' \
    '    :' \
    'else' \
    '    rm -f /tmp/.X11-unix/X99 /tmp/xvfb.pid' \
    '    Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &' \
    '    echo $! > /tmp/xvfb.pid' \
    '    i=0' \
    '    while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done' \
    'fi' \
    'export DISPLAY=:99' \
    'exec /usr/bin/chromium "$@"' > /usr/local/bin/solver-chrome \
    && chmod +x /usr/local/bin/solver-chrome

WORKDIR /app
WORKDIR /app
ENV NODE_ENV=production
# Server image default: bind all interfaces so `docker run -p` / PaaS routing
# works out of the box (local dev via node/compose sets its own API_HOST).
ENV API_HOST=0.0.0.0
# Safe defaults for this image (it runs as root): --no-sandbox is mandatory for
# Chromium as root, --disable-dev-shm-usage avoids small /dev/shm. Deploy-time
# service variables (Railway) override this ENV if a custom value is wanted.
ENV CHROME_ARGS_EXTRA=--no-sandbox,--disable-dev-shm-usage,--disable-gpu

ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY server.mjs solver.mjs ./

# Solver state (worker JSON, Chrome profiles) lives here. Persist it by mounting
# a volume at /app/.state (docker-compose does this; on Railway, attach a Volume
# in the service settings - its builder rejects Dockerfile VOLUME directives).
RUN mkdir -p /app/.state

# Railway injects PORT automatically; server.mjs binds it.
# Do NOT EXPOSE a fixed port here: Railway injects PORT dynamically (e.g. 8080)
# and the server binds it. A hardcoded EXPOSE can prefill the wrong target port
# when generating a Railway domain (edge -> 502 if it mismatches $PORT).
CMD ["dumb-init", "node", "server.mjs"]
