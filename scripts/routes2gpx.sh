#!/usr/bin/env bash
#
# Convert a file of Google Maps directions URLs into GPX files, one per route.
#
#   scripts/routes2gpx.sh                        # route-urls.txt -> routes/
#   scripts/routes2gpx.sh -f trip.txt -d trip    # pick file and output dir
#   scripts/routes2gpx.sh -m motorcycle -s       # extra flags go to gmaps2gpx
#
# Wraps gmaps2gpx, which takes URLs as arguments and has no notion of a URL
# list file. The URLs are handed over NUL-delimited: a place name with an
# apostrophe (Coeur d'Alene) makes plain xargs die with "unterminated quote"
# and drop *every* URL in the file, not just that line.
#
# All URLs go in a single gmaps2gpx call, since it accepts many (nargs="+").
# gmaps2gpx names each output from its origin and destination and ignores -o
# when given more than one URL, so this cd's into the output directory instead
# of trying to control filenames.

set -euo pipefail

URL_FILE="route-urls.txt"
OUT_DIR="routes"
PASSTHRU=()

usage() {
  sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'

Options:
  -f, --file FILE      URL list, one per line (default: route-urls.txt)
                       Blank lines and #-comments are ignored.
  -d, --out-dir DIR    where the .gpx files land (default: routes)
  -n, --dry-run        list the URLs that would be converted, then stop
  -r, --retries N      re-attempt routes that failed (default: 2). Tethered
                       connections drop DNS mid-batch; gmaps2gpx skips the
                       route and carries on, so failures are retried here.
  -w, --dns-wait SEC   before each attempt, wait up to this long for the
                       connection to come back (default: 60, 0 to disable)
  -h, --help           this text

Anything else is passed straight through to gmaps2gpx (-m, -s, -k ...).

The API key comes from $GOOGLE_MAPS_API_KEY, or a GOOGLE_MAPS_API_KEY line
in the repo's .env file.
USAGE
}

DRY_RUN=0
RETRIES=2
DNS_WAIT=60
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--file)    URL_FILE="${2:?--file needs a path}"; shift 2 ;;
    -d|--out-dir) OUT_DIR="${2:?--out-dir needs a path}"; shift 2 ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    -r|--retries) RETRIES="${2:?--retries needs a number}"; shift 2 ;;
    -w|--dns-wait) DNS_WAIT="${2:?--dns-wait needs seconds}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            PASSTHRU+=("$1"); shift ;;
  esac
done

command -v gmaps2gpx >/dev/null 2>&1 || {
  echo "error: gmaps2gpx not found on PATH. Install it with: pipx install gmaps2gpx" >&2
  exit 1
}

[[ -f "$URL_FILE" ]] || { echo "error: no such URL file: $URL_FILE" >&2; exit 1; }

# Resolve before the cd below, so a relative -f path keeps working.
URL_FILE="$(cd "$(dirname "$URL_FILE")" && pwd)/$(basename "$URL_FILE")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

URLS="$(mktemp)"
trap 'rm -f "$URLS"' EXIT INT TERM  # widened below, once the logs exist

# Strip CRs (pasted from Windows), trim surrounding space, drop blanks and
# comments, emit NUL-delimited. awk rather than grep -v so that a file with
# nothing usable does not trip `set -e` on grep's exit status.
awk '{
  sub(/\r$/, "")
  gsub(/^[[:space:]]+|[[:space:]]+$/, "")
  if ($0 != "" && $0 !~ /^#/) printf "%s%c", $0, 0
}' "$URL_FILE" > "$URLS"

COUNT=$(tr -cd '\0' < "$URLS" | wc -c | tr -d ' ')
if [[ "$COUNT" -eq 0 ]]; then
  echo "error: no URLs found in $URL_FILE" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "$COUNT URL(s) in $(basename "$URL_FILE"), would write to $OUT_DIR/:"
  tr '\0' '\n' < "$URLS" | sed 's/^/  /'
  exit 0
fi

# Fall back to the repo .env, which is where this project keeps its keys.
if [[ -z "${GOOGLE_MAPS_API_KEY:-}" && -f "$REPO_ROOT/.env" ]]; then
  KEY_LINE="$(sed -n 's/^[[:space:]]*GOOGLE_MAPS_API_KEY[[:space:]]*=[[:space:]]*//p' "$REPO_ROOT/.env" | tail -1)"
  KEY_LINE="${KEY_LINE%\"}"; KEY_LINE="${KEY_LINE#\"}"
  KEY_LINE="${KEY_LINE%\'}"; KEY_LINE="${KEY_LINE#\'}"
  [[ -n "$KEY_LINE" ]] && export GOOGLE_MAPS_API_KEY="$KEY_LINE"
fi

# Only complain about a missing key if the caller did not pass one themselves.
if [[ -z "${GOOGLE_MAPS_API_KEY:-}" ]] && [[ ! " ${PASSTHRU[*]-} " =~ [[:space:]](-k|--api-key)[[:space:]] ]]; then
  echo "error: no API key. Either:" >&2
  echo "  export GOOGLE_MAPS_API_KEY='...'" >&2
  echo "  or add GOOGLE_MAPS_API_KEY=... to $REPO_ROOT/.env" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
echo "Converting $COUNT route(s) from $(basename "$URL_FILE") into $OUT_DIR/"
cd "$OUT_DIR"

LOG="$(mktemp)"
TRANSIENT="$(mktemp)"
PERMANENT="$(mktemp)"
cleanup() { rm -f "$URLS"* "$LOG" "$TRANSIENT" "$PERMANENT"; }
trap cleanup EXIT
trap 'cleanup; echo; echo "Interrupted."; exit 130' INT TERM

# gmaps2gpx prints "Converting: <url>" then either "  Saved: <path>" or
# "  Failed: <msg>" per route, and always exits 0. Pairing those lines is the
# only way to learn which URLs did not make it.
#
# Failures are split by kind, because only connection-level trouble can
# succeed on a second attempt. An API-level rejection (invalid key, no route
# between the points) fails identically every time, so retrying it only burns
# quota and wall-clock.
classify_failures() {
  : > "$TRANSIENT"
  awk -v tf="$TRANSIENT" -v pf="$PERMANENT" '
    /^Converting: / { url = substr($0, 13); next }
    /^  Saved: /    { url = ""; next }
    /^  Failed: /   {
      if (url == "") next
      msg = substr($0, 11)
      if (msg ~ /HTTPSConnectionPool|NameResolution|Max retries exceeded|ConnectionError|SSLError|Timeout|timed out|Temporary failure|Connection reset/)
        printf "%s%c", url, 0 >> tf
      else
        printf "%s%c", url, 0 >> pf
      url = ""
    }
  ' "$LOG"
}

nulcount() { tr -cd '\0' < "$1" | wc -c | tr -d ' '; }

# On a tethered connection the whole uplink drops for stretches at a time,
# taking every resolver with it. Spending an attempt during an outage wastes
# it, so hold here until the name resolves again. Uses the same getaddrinfo
# path requests does, so this measures exactly what gmaps2gpx will hit.
wait_for_dns() {
  local waited=0 limit="$1"
  while ! python3 -c "import socket,sys
try: socket.getaddrinfo('maps.googleapis.com', 443)
except Exception: sys.exit(1)" 2>/dev/null; do
    if [[ "$waited" -ge "$limit" ]]; then
      echo "  (still no DNS for maps.googleapis.com after ${limit}s — trying anyway)"
      return 1
    fi
    [[ "$waited" -eq 0 ]] && echo "  Waiting for the connection to come back..."
    sleep 5
    waited=$((waited + 5))
  done
  [[ "$waited" -gt 0 ]] && echo "  Connection back after ${waited}s."
  return 0
}

ATTEMPT=1
PENDING="$URLS"
while :; do
  wait_for_dns "$DNS_WAIT" || true

  # PYTHONUNBUFFERED so progress streams rather than arriving in one lump.
  # ${PASSTHRU[@]+...} keeps `set -u` happy when nothing extra was passed.
  PYTHONUNBUFFERED=1 xargs -0 gmaps2gpx ${PASSTHRU[@]+"${PASSTHRU[@]}"} \
    < "$PENDING" 2>&1 | tee "$LOG" || true

  classify_failures
  NTRANS=$(nulcount "$TRANSIENT")

  [[ "$NTRANS" -eq 0 ]] && break

  if [[ "$ATTEMPT" -gt "$RETRIES" ]]; then
    echo
    echo "$NTRANS route(s) still unreachable after $RETRIES retry/retries."
    break
  fi

  # Back off 5s, 15s, 45s...: a flat gap just burns retries inside one outage.
  BACKOFF=$((5 * (3 ** (ATTEMPT - 1))))
  echo
  echo "$NTRANS route(s) hit a connection error — retry $ATTEMPT of $RETRIES in ${BACKOFF}s..."
  sleep "$BACKOFF"
  cp "$TRANSIENT" "$PENDING.retry"
  PENDING="$PENDING.retry"
  ATTEMPT=$((ATTEMPT + 1))
done

NPERM=$(nulcount "$PERMANENT")
NTRANS=$(nulcount "$TRANSIENT")
TOTAL_FAIL=$((NPERM + NTRANS))

if [[ "$NPERM" -gt 0 ]]; then
  echo
  echo "$NPERM route(s) were rejected by the API — retrying these would not help."
  echo "Check the 'Failed:' lines above (a bad key, or no route between the points)."
fi

if [[ "$TOTAL_FAIL" -gt 0 ]]; then
  cat "$PERMANENT" "$TRANSIENT" | tr '\0' '\n' | awk 'NF' > failed-urls.txt
  echo
  echo "Wrote $TOTAL_FAIL failure(s) to $(pwd)/failed-urls.txt — retry just those with:"
  echo "  scripts/routes2gpx.sh -f \"$(pwd)/failed-urls.txt\" -d \"$(pwd)\""
  exit 1
fi
