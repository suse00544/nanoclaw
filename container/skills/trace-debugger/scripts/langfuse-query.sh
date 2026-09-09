#!/bin/sh
set -eu

kind=${1:-}
identifier=${2:-}
profile=${3:-auto}
config_dir=${TRACE_CONFIG_DIR:-/workspace/agent/config}

usage() {
  echo "usage: langfuse-query.sh <trace|session|observations> <id> [auto|production|preview]" >&2
  exit 2
}

case "$kind" in
  trace|session|observations) ;;
  *) usage ;;
esac

[ -n "$identifier" ] || usage

case "$profile" in
  auto|production|preview) ;;
  *) usage ;;
esac

tmp_dir=$(mktemp -d)
trap 'find "$tmp_dir" -type f -delete 2>/dev/null || true; rmdir "$tmp_dir" 2>/dev/null || true' EXIT HUP INT TERM

query_profile() {
  selected=$1
  case "$selected" in
    production) config_file="$config_dir/langfuse.env" ;;
    preview) config_file="$config_dir/langfuse-preview.env" ;;
    *) return 2 ;;
  esac

  [ -r "$config_file" ] || return 2

  case "$kind" in
    trace) path="/api/public/traces/$identifier" ;;
    session) path="/api/public/sessions/$identifier" ;;
    observations) path="/api/public/observations?traceId=$identifier&limit=50" ;;
  esac

  output_file="$tmp_dir/$selected.json"
  status=$(
    set -a
    # shellcheck disable=SC1090
    . "$config_file"
    set +a

    : "${LANGFUSE_PUBLIC_KEY:?missing LANGFUSE_PUBLIC_KEY in $config_file}"
    : "${LANGFUSE_SECRET_KEY:?missing LANGFUSE_SECRET_KEY in $config_file}"
    : "${LANGFUSE_BASE_URL:?missing LANGFUSE_BASE_URL in $config_file}"

    printf 'user = "%s:%s"\n' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | \
      curl --config - --noproxy '*' --silent --show-error \
        --connect-timeout 10 --max-time 45 \
        --output "$output_file" --write-out '%{http_code}' \
        "${LANGFUSE_BASE_URL%/}$path"
  ) || return 2

  case "$status" in
    2??)
      cat "$output_file"
      return 0
      ;;
    *) return 1 ;;
  esac
}

if [ "$profile" = auto ]; then
  if query_profile production; then
    exit 0
  fi
  if query_profile preview; then
    exit 0
  fi
  echo "trace lookup failed in production and preview" >&2
  exit 1
fi

if ! query_profile "$profile"; then
  echo "trace lookup failed in $profile" >&2
  exit 1
fi
