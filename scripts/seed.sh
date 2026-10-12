#!/usr/bin/env bash
# Seed the local Radicale fixture for wycal (CONTRACTS.md §9).
#
# Idempotent: /demo/ and /admin/ and each collection are MKCOLed only when a
# PROPFIND shows they are missing; seed resources are PUT to stable URLs (one
# file per UID, e.g. seed-001@wycal -> /demo/personal.ics/seed-001.ics), so
# re-running overwrites in place and never duplicates.
#
# /admin/ is the CONTRACTS.md §19 fixture account (admin/admin): Inbox/
# (VEVENT+VTODO), Birthdays/ + personal.ics/ calendars, and a contacts/
# addressbook with a BDAY contact that exercises the birthday materializer.
#
# Dates: the .ics/.vcf bodies under scripts/radicale/seed/ are regenerated on
# every run with dates relative to "today" (the current week), so the calendar
# looks alive on first paint regardless of when you seed.
#
# The htpasswd file (demo/demo and admin/admin, bcrypt) lives at
# scripts/radicale/users; regenerate a line with:
#   scripts/radicale/.venv/bin/python -c "import bcrypt; print('demo:' + bcrypt.hashpw(b'demo', bcrypt.gensalt(rounds=12)).decode())" >> scripts/radicale/users
# or provision a whole new user (htpasswd + collections) with scripts/new-user.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DIR="$SCRIPT_DIR/radicale/seed"
BASE="${WYCAL_DAV_URL:-http://127.0.0.1:5232}"
AUTH="${WYCAL_DAV_AUTH:-demo:demo}"
ADMIN_AUTH="${WYCAL_DAV_ADMIN_AUTH:-admin:admin}"

die() { echo "seed: $*" >&2; exit 1; }

# HTTP status code for a request as the given principal (000/empty = unreachable).
code_of_as() { # <auth> <curl args...>
  local auth="$1"; shift
  curl -s -u "$auth" -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true
}

code_of() { code_of_as "$AUTH" "$@"; }

mkdir -p "$SEED_DIR/personal" "$SEED_DIR/work" "$SEED_DIR/family" "$SEED_DIR/contacts" \
  "$SEED_DIR/admin/personal" "$SEED_DIR/admin/inbox" "$SEED_DIR/admin/contacts"

# --- principal home (plain collection at /<user>/) ----------------------------
ensure_principal() { # <path> <auth>
  code="$(code_of_as "$2" -X PROPFIND -H 'Depth: 0' "$BASE$1")"
  if [ "$code" != "207" ]; then
    code="$(code_of_as "$2" -X MKCOL "$BASE$1")"
    [ "$code" = "201" ] || die "MKCOL $1 failed (HTTP $code); is radicale running? scripts/radicale/start.sh"
    echo "seed: created collection root $1"
  fi
}

# --- /demo/ principal + calendar-home collection ------------------------------
ensure_principal /demo/ "$AUTH"

# --- calendars (displayname + calendar-color set at MKCOL time) ---------------
calendar_mkcol_body() { # <displayname> <color> [components] — space-separated, e.g. "VEVENT VTODO"
  local comp comp_xml="" comps="${3:-VEVENT VTODO}"
  for comp in $comps; do comp_xml="$comp_xml<C:comp name=\"$comp\"/>"; done
  cat <<XML
<?xml version="1.0" encoding="utf-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/">
 <D:set>
  <D:prop>
   <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
   <D:displayname>$1</D:displayname>
   <ICAL:calendar-color>$2</ICAL:calendar-color>
   <C:supported-calendar-component-set>$comp_xml</C:supported-calendar-component-set>
  </D:prop>
 </D:set>
</D:mkcol>
XML
}

ensure_calendar() { # <path> <displayname> <color> [auth] [components]
  local auth="${4:-$AUTH}"
  code="$(code_of_as "$auth" -X PROPFIND -H 'Depth: 0' "$BASE$1")"
  if [ "$code" != "207" ]; then
    body="$(calendar_mkcol_body "$2" "$3" "${5:-}")"
    code="$(code_of_as "$auth" -X MKCOL -H 'Content-Type: application/xml; charset=utf-8' --data-binary "$body" "$BASE$1")"
    [ "$code" = "201" ] || die "MKCOL $1 failed (HTTP $code)"
    echo "seed: created calendar $1 ($2, $3)"
  fi
}

ensure_calendar /demo/personal.ics Personal '#fa8d3e'
ensure_calendar /demo/work.ics Work '#55b4d4'
ensure_calendar /demo/family.ics Family '#a37acc'

# --- addressbook ----------------------------------------------------------------
ensure_addressbook() { # <path> [auth]
  local auth="${2:-$AUTH}"
  code="$(code_of_as "$auth" -X PROPFIND -H 'Depth: 0' "$BASE$1")"
  if [ "$code" != "207" ]; then
    body='<?xml version="1.0" encoding="utf-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">
 <D:set>
  <D:prop>
   <D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype>
   <D:displayname>Contacts</D:displayname>
  </D:prop>
 </D:set>
</D:mkcol>'
    code="$(code_of_as "$auth" -X MKCOL -H 'Content-Type: application/xml; charset=utf-8' --data-binary "$body" "$BASE$1")"
    [ "$code" = "201" ] || die "MKCOL $1 failed (HTTP $code)"
    echo "seed: created addressbook $1 (Contacts)"
  fi
}

ensure_addressbook /demo/contacts/ "$AUTH"

# --- /admin/ fixture root (CONTRACTS.md §19): Inbox, Birthdays, personal, contacts ---
ensure_principal /admin/ "$ADMIN_AUTH"
ensure_calendar /admin/Inbox/ Inbox '#39bae6' "$ADMIN_AUTH" 'VEVENT VTODO'
ensure_calendar /admin/Birthdays/ Birthdays '#a37acc' "$ADMIN_AUTH"
ensure_calendar /admin/personal.ics/ Personal '#fa8d3e' "$ADMIN_AUTH"
ensure_addressbook /admin/contacts/ "$ADMIN_AUTH"

# --- repair: calendars created before the VEVENT+VTODO MKCOL default still
# advertise VEVENT-only; re-advertise both on every seeded calendar.
# Idempotent: the PROPPATCH only fires when the PROPFIND shows VTODO missing.
repair_comps() { # <path> <auth>
  local path="$1" auth="$2" find_body patch_body resp code
  find_body='<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:supported-calendar-component-set/></D:prop></D:propfind>'
  resp="$(curl -s -u "$auth" -X PROPFIND -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' --max-time 10 --data-binary "$find_body" "$BASE$path" 2>/dev/null || true)"
  case "$resp" in *'comp name="VTODO"'*) return 0 ;; esac
  patch_body='<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop></D:set></D:propertyupdate>'
  code="$(code_of_as "$auth" -X PROPPATCH -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' --max-time 10 --data-binary "$patch_body" "$BASE$path")"
  [ "$code" = "207" ] || die "repair $path: PROPPATCH failed (HTTP $code)"
  resp="$(curl -s -u "$auth" -X PROPFIND -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' --max-time 10 --data-binary "$find_body" "$BASE$path" 2>/dev/null || true)"
  case "$resp" in
    *'comp name="VTODO"'*) echo "seed: repaired $path component-set (now VEVENT+VTODO)" ;;
    *) die "repair $path: VTODO still missing after PROPPATCH" ;;
  esac
}

repair_comps /demo/personal.ics "$AUTH"
repair_comps /demo/work.ics "$AUTH"
repair_comps /demo/family.ics "$AUTH"
repair_comps /admin/Inbox/ "$ADMIN_AUTH"
repair_comps /admin/Birthdays/ "$ADMIN_AUTH"
repair_comps /admin/personal.ics/ "$ADMIN_AUTH"

# --- regenerate seed bodies, dates relative to today --------------------------
python3 - "$SEED_DIR" <<'PY'
import os
import sys
from datetime import date, datetime, timedelta, timezone

seed_dir = sys.argv[1]
today = date.today()
monday = today - timedelta(days=today.weekday())  # Monday of the current week
tue, wed, thu, fri, sat, sun = (monday + timedelta(days=n) for n in range(1, 7))

now = datetime.now(timezone.utc)
dtstamp = now.strftime("%Y%m%dT%H%M%SZ")
rev = now.strftime("%Y-%m-%dT%H:%M:%SZ")
CRLF = "\r\n"


def dts(d, hh, mm=0):
    return d.strftime("%Y%m%d") + "T%02d%02d00" % (hh, mm)


def cal(events, tz_lines=None):
    head = ["BEGIN:VCALENDAR", "VERSION:2.0",
            "PRODID:-//wycal//Radicale seed fixture 1.0//EN",
            "CALSCALE:GREGORIAN"]
    if tz_lines:
        head += tz_lines
    lines = head + [line for e in events for line in e] + ["END:VCALENDAR"]
    return CRLF.join(lines) + CRLF


def ev(uid, summary, props, valarm=None):
    lines = ["BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + dtstamp] + props
    lines += ["SUMMARY:" + summary]
    if valarm:
        lines += valarm
    lines.append("END:VEVENT")
    return lines


def fold(line):  # vCard 4.0: fold >75 octets, continuation = CRLF + space
    data = line.encode("ascii")
    if len(data) <= 75:
        return line
    chunks = [data[i:i + 74] for i in range(0, len(data), 74)]
    return CRLF.join([chunks[0].decode("ascii")] +
                     [" " + c.decode("ascii") for c in chunks[1:]])


def vcard(uid, fn, props):
    lines = ["BEGIN:VCARD", "VERSION:4.0", "UID:" + uid, "FN:" + fn,
             "REV:" + rev] + props + ["END:VCARD"]
    return CRLF.join(fold(l) for l in lines) + CRLF


def write(rel, text):
    with open(os.path.join(seed_dir, rel), "wb") as fh:
        fh.write(text.encode("utf-8"))


NY_TZ = [
    "BEGIN:VTIMEZONE",
    "TZID:America/New_York",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0400",
    "TZNAME:EDT",
    "DTSTART:19700308T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "TZNAME:EST",
    "DTSTART:19701101T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
]

personal = [
    ev("seed-001@wycal", "Alicia's birthday", [  # today, all-day
        "DTSTART;VALUE=DATE:" + today.strftime("%Y%m%d"),
        "DTEND;VALUE=DATE:" + (today + timedelta(days=1)).strftime("%Y%m%d"),
        "DESCRIPTION:All-day fixture anchored to today",
    ]),
    ev("seed-002@wycal", "Morning swim", [  # today, timed, VALARM
        "DTSTART:" + dts(today, 8, 30),
        "DTEND:" + dts(today, 9, 15),
        "LOCATION:Public pool",
    ], valarm=["BEGIN:VALARM", "ACTION:DISPLAY",
               "DESCRIPTION:Morning swim starts in 10 minutes",
               "TRIGGER:-PT10M", "END:VALARM"]),
    ev("seed-003@wycal", "Gym session", [  # weekly TU,TH
        "DTSTART:" + dts(tue, 7, 0),
        "DTEND:" + dts(tue, 8, 0),
        "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=60",
        "LOCATION:Riverside gym",
    ]),
    ev("seed-004@wycal", "Pay rent", [  # monthly
        "DTSTART:" + dts(today.replace(day=1), 9, 0),
        "DTEND:" + dts(today.replace(day=1), 9, 30),
        "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;COUNT=12",
    ]),
]

work = [
    ev("seed-101@wycal", "Team standup", [  # daily RRULE
        "DTSTART:" + dts(monday, 9, 30),
        "DTEND:" + dts(monday, 10, 0),
        "RRULE:FREQ=DAILY;COUNT=20",
        "LOCATION:Standup room",
    ]),
    ev("seed-102@wycal", "Q4 offsite", [  # multi-day across this week
        "DTSTART:" + dts(wed, 9, 0),
        "DTEND:" + dts(fri, 17, 0),
        "LOCATION:Harborview lodge",
        "DESCRIPTION:Multi-day fixture spanning the current week",
    ]),
    ev("seed-103@wycal", "Design review", [  # overlapping pair, first half
        "DTSTART:" + dts(thu, 13, 0),
        "DTEND:" + dts(thu, 14, 30),
        "LOCATION:Room 2",
    ]),
    ev("seed-104@wycal", "1:1 with manager", [  # overlapping pair, second half
        "DTSTART:" + dts(thu, 14, 0),
        "DTEND:" + dts(thu, 15, 0),
    ]),
    ev("seed-105@wycal", "East coast client call", [  # TZID America/New_York
        "DTSTART;TZID=America/New_York:" + dts(fri, 11, 0),
        "DTEND;TZID=America/New_York:" + dts(fri, 12, 0),
        "LOCATION:Bridge line",
    ]),
    ev("seed-106@wycal", "Roadmap sync", [
        "DTSTART:" + dts(wed, 15, 0),
        "DTEND:" + dts(wed, 16, 0),
        "LOCATION:Room 4",
    ]),
]

family = [
    ev("seed-201@wycal", "Family dinner", [  # today, timed
        "DTSTART:" + dts(today, 18, 30),
        "DTEND:" + dts(today, 20, 0),
    ]),
    ev("seed-202@wycal", "Kids soccer", [  # weekly SA
        "DTSTART:" + dts(sat, 10, 0),
        "DTEND:" + dts(sat, 11, 30),
        "RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=20",
        "LOCATION:South field",
    ]),
    ev("seed-203@wycal", "House cleaning day", [  # weekend all-day
        "DTSTART;VALUE=DATE:" + sat.strftime("%Y%m%d"),
        "DTEND;VALUE=DATE:" + sun.strftime("%Y%m%d"),
    ]),
]

for i, e in enumerate(personal):
    write("personal/seed-%03d.ics" % (i + 1), cal([e]))
for i, e in enumerate(work):
    tz = NY_TZ if i == 4 else None  # seed-105 carries the VTIMEZONE block
    write("work/seed-1%02d.ics" % (i + 1), cal([e], tz_lines=tz))
for i, e in enumerate(family):
    write("family/seed-2%02d.ics" % (i + 1), cal([e]))

# --- /admin/ starter data (CONTRACTS.md §19) ----------------------------------


def td(uid, summary, props):  # VTODO — same envelope rules as ev()
    lines = ["BEGIN:VTODO", "UID:" + uid, "DTSTAMP:" + dtstamp] + props
    lines += ["SUMMARY:" + summary]
    lines.append("END:VTODO")
    return lines


admin_personal = [
    ev("admin-001@wycal", "Admin welcome", [  # today, timed
        "DTSTART:" + dts(today, 9, 0),
        "DTEND:" + dts(today, 9, 30),
        "DESCRIPTION:Starter event for the local admin account",
    ]),
    ev("admin-002@wycal", "Weekly planning", [  # weekly MO, anchored to this week
        "DTSTART:" + dts(monday, 16, 0),
        "DTEND:" + dts(monday, 17, 0),
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=20",
    ]),
    ev("admin-003@wycal", "Admin all-day note", [  # today, all-day
        "DTSTART;VALUE=DATE:" + today.strftime("%Y%m%d"),
        "DTEND;VALUE=DATE:" + (today + timedelta(days=1)).strftime("%Y%m%d"),
    ]),
]

admin_todos = [
    td("admin-401@wycal", "Plain starter task", [
        "STATUS:NEEDS-ACTION",
        "DUE;VALUE=DATE:" + today.strftime("%Y%m%d"),
    ]),
    td("admin-402@wycal", "Tagged urgent task", [
        "STATUS:NEEDS-ACTION",
        "PRIORITY:1",
        "CATEGORIES:inbox,tag",
        "DUE;VALUE=DATE:" + (today + timedelta(days=2)).strftime("%Y%m%d"),
    ]),
    td("admin-403@wycal", "Already done", [
        "STATUS:COMPLETED",
        "PERCENT-COMPLETE:100",
        "COMPLETED:" + dtstamp,
        "DUE;VALUE=DATE:" + (today - timedelta(days=1)).strftime("%Y%m%d"),
    ]),
]

admin_contacts = [
    ("admin-501@wycal", "Jamie Rivera", [  # BDAY exercises the birthday materializer
        "N:Rivera;Jamie;;;",
        "ORG:wycal fixture",
        "TITLE:Local admin",
        "EMAIL;TYPE=work:jamie.rivera@example.com",
        "TEL;TYPE=work:+1 555 0201",
        "BDAY:1990-06-15",
    ]),
    ("admin-502@wycal", "Riley Chen", [  # no BDAY — control row
        "N:Chen;Riley;;;",
        "ORG:wycal fixture",
        "TITLE:Second contact",
        "EMAIL;TYPE=work:riley.chen@example.com",
        "TEL;TYPE=home:+1 555 0202",
    ]),
]

for i, e in enumerate(admin_personal):
    write("admin/personal/admin-%03d.ics" % (i + 1), cal([e]))
for i, t in enumerate(admin_todos):
    write("admin/inbox/admin-4%02d.ics" % (i + 1), cal([t]))
for uid, fn, props in admin_contacts:
    write("admin/contacts/%s.vcf" % uid.split("@")[0], vcard(uid, fn, props))

png1x1 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
          "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
# The ';' and ',' in the data URI are escaped per vCard TEXT rules; Radicale
# normalizes vcards through vobject, which silently drops an unescaped
# payload after the first unescaped comma.
photo = ("PHOTO;VALUE=uri;MEDIATYPE=image/png:data:image/png\\;base64\\,"
         + png1x1)

contacts = [
    ("seed-301@wycal", "Alice Chen", [
        "N:Chen;Alice;;;",
        "ORG:Example Corp;Design",
        "TITLE:Product designer",
        "EMAIL;TYPE=work:alice.chen@example.com",
        "EMAIL;TYPE=home:alice@example.net",
        "TEL;TYPE=work,voice:+1 555 0101",
        "ADR;TYPE=work:;;100 Market Street;San Francisco;CA;94105;USA",
    ]),
    ("seed-302@wycal", "Bob Martinez", [
        "N:Martinez;Bob;;;",
        "ORG:Acme Interactive",
        "TITLE:Frontend engineer",
        "EMAIL;TYPE=work:bob@acme.example",
        "TEL;TYPE=home:+1 555 0102",
        "ADR;TYPE=home:;;88 Pine Avenue;Portland;OR;97204;USA",
    ]),
    ("seed-303@wycal", "Carol O'Brien", [
        "N:O'Brien;Carol;;;",
        "ORG:Northwind Traders",
        "TITLE:Accounts lead",
        "EMAIL;TYPE=work:carol.obrien@northwind.example",
        "TEL;TYPE=cell:+1 555 0103",
        "NOTE:Prefers email over phone",
    ]),
    ("seed-304@wycal", "Dara Haddad", [
        "N:Haddad;Dara;;;",
        "ORG:Solaris Labs",
        "TITLE:Research engineer",
        "EMAIL;TYPE=work:dara@solaris.example",
        "TEL;TYPE=work:+1 555 0104",
        "TEL;TYPE=cell:+1 555 0105",
        "ADR;TYPE=work:;;1 Circular Road;Cupertino;CA;95014;USA",
    ]),
    ("seed-305@wycal", "Evan Wu", [
        "N:Wu;Evan;;;",
        "ORG:Wulfram Consulting",
        "TITLE:Principal",
        "EMAIL;TYPE=work:evan@wulfram.example",
        photo,
        "ADR;TYPE=work:;;221B Baker Street;London;;NW1 6XE;United Kingdom",
    ]),
    ("seed-306@wycal", "Farida Noor", [
        "N:Noor;Farida;;;",
        "ORG:Kite and Anchor",
        "TITLE:Operations",
        "EMAIL;TYPE=work:farida@kiteanchor.example",
        "TEL;TYPE=work:+49 30 5550106",
        "ADR;TYPE=work:;;Torstrasse 10;Berlin;;10119;Germany",
    ]),
    ("seed-307@wycal", "Gregor Ivanov", [
        "N:Ivanov;Gregor;;;",
        "TITLE:Freelance photographer",
        "EMAIL;TYPE=work:gregor@studio.example",
        "EMAIL;TYPE=home:gregor.ivanov@mail.example",
        "TEL;TYPE=cell:+1 555 0107",
    ]),
    ("seed-308@wycal", "Hana Suzuki", [
        "N:Suzuki;Hana;;;",
        "ORG:Sakura Systems",
        "TITLE:Program manager",
        "EMAIL;TYPE=work:hana.suzuki@sakura.example",
        "TEL;TYPE=work:+81 3 5555 0108",
        "ADR;TYPE=work:;;1-2-3 Shibuya;Tokyo;;150-0002;Japan",
    ]),
]
for uid, fn, props in contacts:
    write("contacts/%s.vcf" % uid.split("@")[0], vcard(uid, fn, props))
PY

# --- PUT every seed file to its stable URL ------------------------------------
put_dir() { # <seed-subdir> <collection-path> <content-type> [auth]
  local f name code
  local auth="${4:-$AUTH}"
  for f in "$SEED_DIR/$1"/*; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    code="$(code_of_as "$auth" -X PUT -H "Content-Type: $3; charset=utf-8" --data-binary @"$f" "$BASE/$2/$name")"
    case "$code" in
      201|204) ;;
      *) die "PUT $2/$name failed (HTTP $code)" ;;
    esac
  done
}

put_dir personal demo/personal.ics text/calendar
put_dir work demo/work.ics text/calendar
put_dir family demo/family.ics text/calendar
put_dir contacts demo/contacts text/vcard
put_dir admin/personal admin/personal.ics text/calendar "$ADMIN_AUTH"
put_dir admin/inbox admin/Inbox text/calendar "$ADMIN_AUTH"
put_dir admin/contacts admin/contacts text/vcard "$ADMIN_AUTH"

echo "seed: ok — demo 13 events (personal 4, work 6, family 3) + 8 contacts; admin 3 events + 3 todos + 2 contacts at $BASE"
