#!/usr/bin/env sh
set -eu

usage() {
  printf '%s\n' "Usage: $0 [--no-browser]"
}

open_browser=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-browser)
      open_browser=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '%s\n' "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
port=${PORT:-4201}
url="http://127.0.0.1:$port"
server_entry="$repo_root/dist/server/index.js"

is_monitor_responding() {
  command -v curl >/dev/null 2>&1 &&
    curl -fsS --max-time 3 "$url/api/health" >/dev/null 2>&1
}

is_port_listening() {
  if command -v lsof >/dev/null 2>&1 &&
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi

  if command -v ss >/dev/null 2>&1 &&
    ss -ltn 2>/dev/null | grep -E "[.:]$port[[:space:]]" >/dev/null 2>&1; then
    return 0
  fi

  if command -v netstat >/dev/null 2>&1 &&
    netstat -an 2>/dev/null | grep -E "[.:]$port[[:space:]].*LISTEN" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

open_url() {
  case "$(uname -s)" in
    Darwin*)
      open "$1" >/dev/null 2>&1 &
      ;;
    Linux*)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1 &
      else
        printf '%s\n' "Codex Monitor is running at $1"
      fi
      ;;
    *)
      printf '%s\n' "Codex Monitor is running at $1"
      ;;
  esac
}

if [ ! -f "$server_entry" ]; then
  (cd "$repo_root" && npm run build)
fi

if is_monitor_responding; then
  :
elif is_port_listening; then
  if command -v curl >/dev/null 2>&1; then
    printf '%s\n' "Port $port is already in use, but Codex Monitor did not respond."
  else
    printf '%s\n' "Port $port is already in use; leaving the existing listener in place."
  fi
else
  out_log="$repo_root/codex-monitor.out.log"
  err_log="$repo_root/codex-monitor.err.log"

  (
    cd "$repo_root"
    NODE_ENV=production PORT="$port" nohup node dist/server/index.js >>"$out_log" 2>>"$err_log" &
  )

  sleep 2
fi

if [ "$open_browser" -eq 1 ]; then
  open_url "$url"
fi
