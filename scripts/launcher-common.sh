#!/usr/bin/env sh
# Shared by the on-demand macOS/Linux launchers. Do not change the user's shell.
prepare_node_path() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi
  for bin_dir in /opt/homebrew/bin /usr/local/bin /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
    if [ -x "$bin_dir/node" ]; then
      PATH="$bin_dir:$PATH"
      export PATH
      return 0
    fi
  done
  printf '%s\n' "Node.js is required. Install Node.js 22 or newer and retry." >&2
  return 1
}

resolve_codex_cli() {
  if [ -n "${CODEX_MONITOR_CODEX_PATH:-}" ] && [ -x "$CODEX_MONITOR_CODEX_PATH" ]; then
    printf '%s\n' "$CODEX_MONITOR_CODEX_PATH"
    return 0
  fi
  if [ -n "${CODEX_BIN:-}" ] && [ -x "$CODEX_BIN" ]; then
    printf '%s\n' "$CODEX_BIN"
    return 0
  fi
  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return 0
  fi
  if [ "$(uname -s)" = Darwin ]; then
    for app_root in "$HOME/Applications" /Applications; do
      for app_name in Codex.app ChatGPT.app; do
        candidate="$app_root/$app_name/Contents/Resources/codex"
        if [ -f "$candidate" ] && [ -x "$candidate" ]; then
          printf '%s\n' "$candidate"
          return 0
        fi
      done
    done
  fi
  return 1
}
