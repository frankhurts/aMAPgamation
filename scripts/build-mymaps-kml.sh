#!/usr/bin/env bash
#
# Turn a combined GPX into a KML that Google My Maps imports as one clean layer.
#
#   scripts/build-mymaps-kml.sh routes/all_routes.gpx routes/all_routes_mymaps.kml
#   scripts/build-mymaps-kml.sh in.gpx out.kml --name "Montana trip" --points 1500
#
# Three problems this solves, none of which the GPX itself can:
#
#  1. My Maps invents a "Start of <track>" and "End of <track>" pin for every
#     track in an imported GPX, duplicating the real stops. KML placemarks are
#     taken literally, so switching format removes them at the source.
#  2. Google's directions polylines are absurdly dense (~17k points/route),
#     blowing the 5MB-per-layer limit. simplify trims them.
#  3. Each leg writes a start AND an end waypoint, so every overnight stop
#     appears twice. duplicate,location collapses them by coordinate.

set -euo pipefail

IN="${1:?usage: build-mymaps-kml.sh <in.gpx> <out.kml> [--name TITLE] [--points N]}"
OUT="${2:?usage: build-mymaps-kml.sh <in.gpx> <out.kml> [--name TITLE] [--points N]}"
shift 2

NAME="Routes"
POINTS=2000
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="${2:?--name needs a title}"; shift 2 ;;
    --points) POINTS="${2:?--points needs a number}"; shift 2 ;;
    *) echo "error: unknown option $1" >&2; exit 1 ;;
  esac
done

command -v gpsbabel >/dev/null || { echo "error: gpsbabel not on PATH" >&2; exit 1; }
[[ -f "$IN" ]] || { echo "error: no such file: $IN" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d -t mymaps)"
TMP="$WORK/filtered.gpx"
trap 'rm -rf "$WORK"' EXIT INT TERM

# Dedupe stops by coordinate, then cap each track's point count. simplify uses
# cross-track error, so it drops redundant vertices rather than every Nth one.
gpsbabel -i gpx -f "$IN" \
  -x duplicate,location \
  -x "simplify,count=$POINTS" \
  -o gpx -F "$TMP"

python3 "$HERE/gpx2mymaps.py" "$TMP" "$OUT" --name "$NAME"

SIZE=$(wc -c < "$OUT")
printf "  %.2f MB" "$(echo "$SIZE" | awk '{print $1/1048576}')"
if [[ "$SIZE" -lt 5242880 ]]; then
  echo " — under the 5MB My Maps layer limit"
else
  echo " — OVER 5MB; rerun with a smaller --points"
  exit 1
fi
