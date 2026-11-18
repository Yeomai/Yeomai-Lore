#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT/data/local/run"

kill_tree() {
  parent="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      taskkill //PID "$parent" //T //F >/dev/null 2>&1 || true
      return
      ;;
  esac
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$parent" 2>/dev/null || true
}

for name in gateway web api worker lore; do
  pid_file="$RUN_DIR/$name.pid"
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file")"
    kill_tree "$pid"
    rm -f "$pid_file"
    echo "Stopped $name"
  fi
done

# A failed duplicate start can overwrite pid files while older services keep running.
for pid in $(pgrep -f '[s]cripts/start-local\.sh' 2>/dev/null || true); do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  if [ "$cwd" = "$ROOT" ]; then
    kill_tree "$pid"
  fi
done

stop_port() {
  proto="$1"
  port="$2"
  for pid in $(lsof -ti"$proto" ":$port" 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    case "$cwd" in
      "$ROOT"|"$ROOT"/*) kill_tree "$pid" ;;
    esac
  done
}

stop_port TCP 3000
stop_port UDP 3000
stop_port TCP 4000
stop_port TCP 41340
stop_port TCP 41337
stop_port UDP 41337
