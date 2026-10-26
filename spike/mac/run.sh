#!/usr/bin/env bash
# Runs a command in the spike's clean environment: only the variables listed here survive from the caller.
set -euo pipefail
exec /usr/bin/env -i SPIKE_CLEAN=1 "SPIKE=${SPIKE:-/tmp/sbd-spike}" "TERM=${TERM:-xterm-256color}" "USER=${USER:-spike}" LOGNAME="${USER:-spike}" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin "$@"
