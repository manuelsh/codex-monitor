#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
launcher_script="$repo_root/scripts/start-codex-with-monitor.sh"

write_linux_desktop_file() {
  target=$1
  escaped_launcher=$(printf '%s' "$launcher_script" | sed 's/\\/\\\\/g; s/"/\\"/g')

  cat >"$target" <<EOF
[Desktop Entry]
Type=Application
Name=Codex with Monitor
Comment=Start Codex and Codex Monitor on demand
Exec=/bin/sh "$escaped_launcher"
Icon=utilities-terminal
Terminal=true
Categories=Development;
StartupNotify=false
EOF
}

case "$(uname -s)" in
  Darwin*)
    desktop="$HOME/Desktop"
    mkdir -p "$desktop"
    shortcut="$desktop/Codex with Monitor.command"

    cat >"$shortcut" <<EOF
#!/usr/bin/env sh
exec /bin/sh "$launcher_script" "\$@"
EOF
    chmod +x "$shortcut"

    printf '%s\n' "Created $shortcut"
    printf '%s\n' "Use it to start Codex with Codex Monitor on demand."
    ;;
  Linux*)
    applications="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$applications"
    app_shortcut="$applications/codex-with-monitor.desktop"
    write_linux_desktop_file "$app_shortcut"
    chmod +x "$app_shortcut"

    desktop_dir="${XDG_DESKTOP_DIR:-$HOME/Desktop}"
    if [ -d "$desktop_dir" ]; then
      desktop_shortcut="$desktop_dir/Codex with Monitor.desktop"
      write_linux_desktop_file "$desktop_shortcut"
      chmod +x "$desktop_shortcut"
      printf '%s\n' "Created $desktop_shortcut"
    fi

    printf '%s\n' "Created $app_shortcut"
    printf '%s\n' "Use the launcher to start Codex with Codex Monitor on demand."
    ;;
  *)
    printf '%s\n' "This installer supports macOS and Linux. Run scripts/start-codex-with-monitor.sh directly on this platform." >&2
    exit 1
    ;;
esac
