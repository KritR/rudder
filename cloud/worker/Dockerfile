FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client tar gzip zsh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g acpx@latest hunkdiff@latest

WORKDIR /opt/rudder
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY assets ./assets
RUN npm link

WORKDIR /workspace

COPY cloud/worker/entrypoint.sh /usr/local/bin/rudder-worker
RUN chmod +x /usr/local/bin/rudder-worker

ENTRYPOINT ["rudder-worker"]
