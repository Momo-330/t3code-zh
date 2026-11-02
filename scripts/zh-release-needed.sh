#!/usr/bin/env bash
set -euo pipefail

node "$(dirname "$0")/../.github/scripts/release-policy.cjs"
