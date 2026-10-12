#!/usr/bin/env bash
# End-to-end check of the wycal Radicale fixture (CONTRACTS.md §9):
#   1. boots a fresh server on 127.0.0.1:5232 (wipes scripts/radicale/data)
#   2. seeds it via scripts/seed.sh
#   3. curl-verifies PROPFIND / sync-collection REPORT / calendar-query REPORT
#   4. re-runs seed.sh and asserts collection sizes unchanged (idempotency)
#   5. kills the server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RADICALE_DIR="$SCRIPT_DIR/radicale"
BASE="${WYCAL_DAV_URL:-http://127.0.0.1:5232}"
AUTH="${WYCAL_DAV_AUTH:-demo:demo}"
LOG="${TMPDIR:-/tmp}/wycal-radicale-verify.log"

die() { echo "verify-dav: $*" >&2; exit 1; }

probe="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/" 2>/dev/null || true)"
if [ -n "$probe" ] && [ "$probe" != "000" ]; then
  die "port 5232 already in use (HTTP $probe); stop the other radicale first"
fi

rm -rf "$RADICALE_DIR/data"
"$RADICALE_DIR/start.sh" >"$LOG" 2>&1 &
RAD_PID=$!
trap 'kill "$RAD_PID" 2>/dev/null || true' EXIT

probe="000"
for _ in $(seq 1 50); do
  probe="$(curl -s -u "$AUTH" -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/demo/" 2>/dev/null || true)"
  if [ -n "$probe" ] && [ "$probe" != "000" ]; then break; fi
  sleep 0.3
done
if [ -z "$probe" ] || [ "$probe" = "000" ]; then
  die "radicale did not come up; server log:
$(cat "$LOG")"
fi

req() { curl -sS -u "$AUTH" "$@"; }
# split "body\nstatus" output from req -w
split_resp() { RESP="$1"; CODE="${RESP##*$'\n'}"; BODY="${RESP%$'\n'*}"; }
count_responses() { printf '%s' "$1" | grep -Eo '<[A-Za-z0-9]*:?response>' | wc -l | tr -d ' '; }

echo "== seeding =="
bash "$SCRIPT_DIR/seed.sh"

echo
echo "== check 1: PROPFIND Depth:1 on /demo/ lists all four collections =="
split_resp "$(req -X PROPFIND -H 'Depth: 1' -w $'\n%{http_code}' "$BASE/demo/")"
[ "$CODE" = "207" ] || die "PROPFIND /demo/ returned HTTP $CODE, expected 207"
for href in /demo/personal.ics/ /demo/work.ics/ /demo/family.ics/ /demo/contacts/; do
  printf '%s' "$BODY" | grep -qF "$href" || die "PROPFIND /demo/ response is missing $href"
done
n="$(count_responses "$BODY")"
[ "$n" = "5" ] || die "PROPFIND /demo/ listed $n responses, expected 5 (self + 4 collections)"
printf '%s\n' "$BODY"

echo
echo "== check 2: sync-collection REPORT Depth:0 on /demo/personal.ics/ returns a sync-token =="
SYNC_BODY='<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
 <D:sync-token/>
 <D:sync-level>1</D:sync-level>
 <D:limit><D:nresults>100</D:nresults></D:limit>
 <D:prop><D:getetag/></D:prop>
</D:sync-collection>'
split_resp "$(req -X REPORT -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' \
  --data-binary "$SYNC_BODY" -w $'\n%{http_code}' "$BASE/demo/personal.ics/")"
[ "$CODE" = "207" ] || die "sync-collection returned HTTP $CODE, expected 207"
TOKEN="$(printf '%s' "$BODY" | grep -Eo '<[A-Za-z0-9]*:?sync-token>[^<]*' | head -1 | sed -E 's/<[^>]*>//')"
[ -n "$TOKEN" ] || die "sync-collection response has no sync-token"
printf '%s\n' "$BODY"
echo "sync-token: $TOKEN"

echo
echo "== check 3: calendar-query REPORT with this week's time-range returns seeded events =="
RANGES="$(python3 -c '
from datetime import date, timedelta
t = date.today()
m = t - timedelta(days=t.weekday())
f = lambda d: d.strftime("%Y%m%d") + "T000000Z"
print(f(m), f(m + timedelta(days=7)))')"
RANGE_START="${RANGES%% *}"
RANGE_END="${RANGES##* }"
CALQ_BODY='<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
 <D:prop>
  <D:getetag/>
  <C:calendar-data/>
 </D:prop>
 <C:filter>
  <C:comp-filter name="VCALENDAR">
   <C:comp-filter name="VEVENT">
    <C:time-range start="'"$RANGE_START"'" end="'"$RANGE_END"'"/>
   </C:comp-filter>
  </C:comp-filter>
 </C:filter>
</C:calendar-query>'
echo "time-range: $RANGE_START .. $RANGE_END"
split_resp "$(req -X REPORT -H 'Depth: 1' -H 'Content-Type: application/xml; charset=utf-8' \
  --data-binary "$CALQ_BODY" -w $'\n%{http_code}' "$BASE/demo/work.ics/")"
[ "$CODE" = "207" ] || die "calendar-query returned HTTP $CODE, expected 207"
for uid in seed-101 seed-102 seed-103 seed-104 seed-105 seed-106; do
  printf '%s' "$BODY" | grep -qF "$uid" || die "calendar-query response is missing $uid"
done
printf '%s\n' "$BODY"

echo
echo "== check 4: re-seed is idempotent (collection sizes unchanged) =="
bash "$SCRIPT_DIR/seed.sh" >/dev/null
size() { split_resp "$(req -X PROPFIND -H 'Depth: 1' -w $'\n%{http_code}' "$BASE$1")"; \
  [ "$CODE" = "207" ] || die "PROPFIND $1 returned HTTP $CODE"; count_responses "$BODY"; }
[ "$(size /demo/personal.ics/)" = "5" ] || die "personal.ics duplicated on re-seed (expected 1 collection + 4 items)"
[ "$(size /demo/work.ics/)" = "7" ] || die "work.ics duplicated on re-seed (expected 1 collection + 6 items)"
[ "$(size /demo/family.ics/)" = "4" ] || die "family.ics duplicated on re-seed (expected 1 collection + 3 items)"
[ "$(size /demo/contacts/)" = "9" ] || die "contacts duplicated on re-seed (expected 1 collection + 8 items)"
echo "personal=1+4 work=1+6 family=1+3 contacts=1+8 — no duplicates"

echo
kill "$RAD_PID" 2>/dev/null || true
wait "$RAD_PID" 2>/dev/null || true
trap - EXIT
echo "verify-dav: PASS"
