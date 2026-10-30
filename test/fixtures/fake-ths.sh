#!/bin/sh
# Stands in for the `ths` launcher. FAKE_THS_API is the mock dashboard; FAKE_THS_LOG records invocations.
# `start` blocks until SIGINT like the real one, then "cleans up" and exits FAKE_THS_STOP_CODE (default 0).
echo "$*" >> "${FAKE_THS_LOG:-/dev/null}"
name=default
if [ "$1" = "--name" ]; then name=$2; shift 2; fi
cmd=$1

case "$cmd" in
  start)
    if [ -n "$FAKE_THS_START_FAIL" ]; then echo "error: port 32805 is already in use" >&2; exit 1; fi
    echo "Starting $name…"
    touch "$FAKE_THS_STATE.$name"
    trap 'echo "Deleting $name"; rm -f "$FAKE_THS_STATE.$name"; exit ${FAKE_THS_STOP_CODE:-0}' INT
    echo "$name is ready"
    while :; do sleep 0.1; done
    ;;
  wait)
    [ -f "$FAKE_THS_STATE.$name" ] || { echo "error: no instance named $name" >&2; exit 1; }
    echo '{"settled":true,"settlement_blocker":null}'
    ;;
  endpoints)
    printf '{"dashboard":"%s/","rpc":"%s/rpc","lightwalletd":"http://127.0.0.1:9067","p2p":"127.0.0.1:18233","network":"%s","tls":false}\n' \
      "$FAKE_THS_API" "$FAKE_THS_API" "${FAKE_THS_NETWORK:-regtest}"
    ;;
  *)
    echo "unsupported: $cmd" >&2; exit 2
    ;;
esac
