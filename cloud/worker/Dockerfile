FROM rust:1-bookworm AS native-builder
WORKDIR /src
COPY native ./native
COPY Cargo.toml Cargo.lock ./
RUN cargo build --release --manifest-path native/Cargo.toml \
  && cp target/release/rudder-native /rudder-native \
  || cp native/target/release/rudder-native /rudder-native

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client tar gzip zsh \
    python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    @anthropic-ai/claude-code@latest \
    @openai/codex@latest \
    acpx@latest \
    hunkdiff@latest \
  && npm cache clean --force

WORKDIR /opt/rudder
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY assets ./assets
COPY --from=native-builder /rudder-native ./dist/native/rudder-native
RUN chmod +x ./dist/native/rudder-native && npm link

WORKDIR /opt/rudder-worker
COPY cloud/worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force
COPY cloud/worker/supervisor.mjs ./supervisor.mjs

COPY cloud/worker/entrypoint.sh /usr/local/bin/rudder-worker
RUN chmod +x /usr/local/bin/rudder-worker

# Claude refuses --permission-mode bypassPermissions as root, so we run the
# supervisor (and everything it spawns) as a non-root user.
RUN useradd --create-home --shell /bin/bash --uid 1500 rudder \
  && mkdir -p /workspace \
  && chown -R rudder:rudder /workspace /opt/rudder-worker

USER rudder
WORKDIR /workspace

ENTRYPOINT ["rudder-worker"]
