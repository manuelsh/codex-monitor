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
. "$script_dir/launcher-common.sh"
prepare_node_path
port=${PORT:-4201}
url="http://127.0.0.1:$port"
server_entry="$repo_root/dist/server/index.js"

is_monitor_responding() {
  node --input-type=module -e '
    try {
      const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(3000) });
      const health = await response.json();
      process.exit(response.ok && health.ok === true ? 0 : 1);
    } catch { process.exit(1); }
  ' "$url/api/health" >/dev/null 2>&1
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

if is_monitor_responding; then
  :
elif is_port_listening; then
  printf '%s\n' "Port $port is already in use, but Codex Monitor did not respond." >&2
  exit 1
else
  if [ ! -f "$server_entry" ] || [ ! -f "$repo_root/dist/web/index.html" ]; then
    (cd "$repo_root" && npm run build)
  fi
  out_log="$repo_root/codex-monitor.out.log"
  err_log="$repo_root/codex-monitor.err.log"

  (
    cd "$repo_root"
    NODE_ENV=production PORT="$port" nohup node dist/server/index.js >>"$out_log" 2>>"$err_log" &
  )

  attempts=0
  until is_monitor_responding; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      printf '%s\n' "Codex Monitor did not become ready at $url. Check $err_log and $out_log." >&2
      exit 1
    fi
    sleep 1
  done
fi

printf '%s\n' "Codex Monitor is running at $url"

if [ "$open_browser" -eq 1 ]; then
  open_url "$url"
fi
