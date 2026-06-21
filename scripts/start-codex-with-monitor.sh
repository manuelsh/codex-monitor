#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage: start-codex-with-monitor.sh [--cli] [--] [codex args...]

Starts Codex Monitor in the background, then opens the Codex desktop app when
one is discoverable. Use --cli to run the Codex CLI instead.
EOF
}

cli=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cli)
      cli=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

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

  return 1
}

run_codex_cli() {
  codex_path=$(resolve_codex_cli) || {
    printf '%s\n' "Could not find codex in PATH. Set CODEX_BIN or CODEX_MONITOR_CODEX_PATH." >&2
    exit 1
  }

  "$codex_path" "$@"
}

find_linux_desktop_id() {
  for dir in \
    "$HOME/.local/share/applications" \
    "/usr/local/share/applications" \
    "/usr/share/applications" \
    "$HOME/.local/share/flatpak/exports/share/applications" \
    "/var/lib/flatpak/exports/share/applications"; do
    [ -d "$dir" ] || continue

    for file in "$dir"/*.desktop; do
      [ -f "$file" ] || continue
      if grep -Eiq '^(Name=.*Codex|Exec=.*codex)' "$file"; then
        basename "$file" .desktop
        return 0
      fi
    done
  done

  return 1
}

start_codex_desktop_app() {
  case "$(uname -s)" in
    Darwin*)
      if command -v open >/dev/null 2>&1 &&
        { [ -d "/Applications/Codex.app" ] || [ -d "$HOME/Applications/Codex.app" ]; }; then
        open -a "Codex" >/dev/null 2>&1
        return 0
      fi
      ;;
    Linux*)
      if command -v gtk-launch >/dev/null 2>&1; then
        desktop_id=$(find_linux_desktop_id || true)
        if [ -n "$desktop_id" ] && gtk-launch "$desktop_id" >/dev/null 2>&1; then
          return 0
        fi
      fi
      ;;
  esac

  run_codex_cli "$@"
}

sh "$script_dir/start-codex-monitor.sh" --no-browser

if [ "$cli" -eq 1 ]; then
  run_codex_cli "$@"
else
  start_codex_desktop_app "$@"
fi
