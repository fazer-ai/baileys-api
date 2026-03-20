#!/bin/bash
# Runs `bun check` before letting the agent stop, but only if relevant files changed.
# Returns ok:false with a reason if checks fail, so the agent continues to fix issues.

# Read stdin (hook input JSON) — check if stop hook is already active to avoid infinite loops
input=$(cat)
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // false')

if [ "$stop_hook_active" = "true" ]; then
  echo '{"ok": true}'
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo '{"ok": false, "reason": "Unable to resolve git repository root before running bun check."}'
  exit 0
}
cd "$repo_root" || {
  echo '{"ok": false, "reason": "Unable to access git repository root before running bun check."}'
  exit 0
}

# Only run if there are uncommitted changes to files that bun check cares about
changed_files=$(git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)
relevant=$(echo "$changed_files" | grep -E '\.(ts|tsx|js|jsx|json|css|prisma)$' | head -1)

if [ -z "$relevant" ]; then
  echo '{"ok": true}'
  exit 0
fi

if bun check 2>&1; then
  echo '{"ok": true}'
else
  echo '{"ok": false, "reason": "bun check failed. Please fix the lint, type-check, or test issues above before stopping."}'
fi
