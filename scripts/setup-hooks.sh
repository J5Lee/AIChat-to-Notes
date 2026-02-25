#!/bin/zsh
set -euo pipefail

# One-time setup for tracked hooks living in .githooks/

git config core.hooksPath .githooks

echo "[ok] core.hooksPath set to .githooks"
echo "Set peer (tailscale IP):"
echo "  git config sync.peerSsh 'joey@<peer-ip>'"
echo "Optional:"
echo "  git config sync.peerWorktree '/Users/joey/project/<repo>'"
