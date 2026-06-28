#!/usr/bin/env bash
set -euo pipefail

compose() {
  docker compose --env-file "${COMPOSE_ENV_FILE:-.env.compose.example}" "$@"
}

cleanup() {
  compose down --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

compose config >/dev/null
compose build migrate web worker
compose up -d postgres
compose run --rm migrate
compose up -d web

for _ in $(seq 1 30); do
  if compose exec -T web node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 2
done

compose exec -T web node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
compose run --rm --no-deps -e MTTR_WORKER_SMOKE=1 worker pnpm start:worker

echo "compose smoke passed"
