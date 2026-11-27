#!/usr/bin/env bash
# PreToolUse: warn the agent (GUARD_ASK=1: ask) before an edit to a gate itself (hooks, settings, git hooks, knip config), a command that bypasses one, or a
# commit declaring a Guard-loosened trailer; baselines and rosters are scored at commit by scripts/guard-loosen.ts (logic: guard-ask.mjs).
node "$(dirname "$0")/guard-ask.mjs" 2>/dev/null || exit 0
