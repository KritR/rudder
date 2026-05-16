#!/usr/bin/env sh
set -eu

exec node /opt/rudder-worker/supervisor.mjs "$@"
