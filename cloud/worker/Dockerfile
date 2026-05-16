FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client tar gzip zsh \
    python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g acpx@latest @openai/codex@latest \
  && npm cache clean --force

WORKDIR /opt/rudder
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY assets ./assets
RUN npm link

WORKDIR /opt/rudder-worker
COPY cloud/worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force
COPY cloud/worker/supervisor.mjs ./supervisor.mjs

WORKDIR /workspace

COPY cloud/worker/entrypoint.sh /usr/local/bin/rudder-worker
RUN chmod +x /usr/local/bin/rudder-worker

ENTRYPOINT ["rudder-worker"]
