#!/bin/zsh
set -euo pipefail

unset HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

exec /opt/homebrew/bin/node /Users/jasongraham/.openclaw/repos/henry-operating-system/operating-system/build-shadow-input.mjs \
  --product=TEMS \
  --repository=jgraham310/tems \
  --repo-path=/Users/jasongraham/tems \
  --ledger=/Users/jasongraham/.openclaw/workspace-cos/ops/operating-system/control-plane.json \
  --priorities=/Users/jasongraham/.openclaw/workspace-cos/priorities.md \
  --output=/Users/jasongraham/.openclaw/workspace-tems-cto/inputs/latest.json \
  --ledger-namespace=tems \
  --mode=routine
