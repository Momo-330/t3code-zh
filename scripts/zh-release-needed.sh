#!/usr/bin/env bash
set -euo pipefail

publish=false
latest=$(git for-each-ref --count=1 --sort=-version:refname --format='%(refname:short)' 'refs/tags/zh-v*')
hour=$(date -u +%H)
hour=$((10#$hour))
if [[ "${FORCE_RELEASE:-false}" == true ]]; then
  publish=true
elif (( hour % RELEASE_HOUR_MOD == RELEASE_HOUR_OFFSET )); then
  # An earlier hourly run may have merged changes without releasing them.
  if [[ -z "$latest" ]] || [[ "$(git rev-parse "$latest^{commit}")" != "$(git rev-parse HEAD)" ]]; then
    publish=true
  fi
fi
printf 'publish=%s\n' "$publish" >> "$GITHUB_OUTPUT"
