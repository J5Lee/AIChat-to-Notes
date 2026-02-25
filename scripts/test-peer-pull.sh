#!/bin/zsh
set -euo pipefail

PEER_SSH="$(git config --get sync.peerSsh || true)"
PEER_WORKTREE="$(git config --get sync.peerWorktree || true)"
[ -n "$PEER_WORKTREE" ] || PEER_WORKTREE="$(pwd)"

if [ -z "$PEER_SSH" ]; then
  echo "sync.peerSsh is not set" >&2
  exit 2
fi

echo "Peer: $PEER_SSH"
echo "Peer worktree: $PEER_WORKTREE"

set -x
ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$PEER_SSH" \
  "cd '$PEER_WORKTREE' && git rev-parse HEAD && echo OK"
