#!/usr/bin/env bash
# Seed a RICH demo/demo fixture for wycal, exercising every app feature
# (CONTRACTS.md §1–§23): timed/all-day/multi-day/recurring events + overrides,
# TZID, floating times, cross-midnight, X-WYCAL-COLOR, CATEGORIES, STATUS/URL,
# folded DESCRIPTIONs, VTODOs with PRIORITY/DUE/DTSTART-scheduled/STATUS/
# PERCENT-COMPLETE/COMPLETED/CATEGORIES + org-style "Next:" notes, and
# vCards with BDAY (incl. reduced --MMDD) and PHOTO;VALUE=URI.
#
# Everything lives under /demo/; the admin account is never touched.
#   personal.ics/ p101–p110   work.ics/ w201–w204   family.ics/ f301–f303
#   Inbox/        t401–t418   contacts/  c501–c508 + c109–c112
# Birthdays/ and Inbox/ collections are kept as-is (only ensured if missing).
#
# Idempotent: stable hrefs (one resource per UID, e.g. p101@wycal ->
# /demo/personal.ics/p101.ics) so re-running overwrites in place. The initial
# DELETE sweep only removes hrefs it knows (the old seed-* fixture and this
# script's own targets), never arbitrary user data.
#
# Dates are pinned to the Oct–Dec 2026 demo window (DTSTAMP 20261010T000000Z).
# Follows scripts/seed.sh's curl PUT patterns; same BASE/AUTH env overrides.

set -euo pipefail

BASE="${WYCAL_DAV_URL:-http://127.0.0.1:5232}"
AUTH="${WYCAL_DAV_AUTH:-demo:demo}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

code_of() { # HTTP status for a request (000 = unreachable)
  curl -s -u "$AUTH" -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true
}

FAILS=0

put_file() { # <href> <file> <content-type> — record any non-201/204
  local code
  code="$(code_of -X PUT -H "Content-Type: $3" --data-binary "@$2" "$BASE$1")"
  case "$code" in
    201|204) return 0 ;;
  esac
  echo "seed-demo: FAIL PUT $1 -> HTTP $code" >&2
  FAILS=$((FAILS + 1))
}

put_dir() { # <label> <tmp-subdir> <collection-path> <content-type>
  local label="$1" dir="$TMP/$2" coll="$3" ctype="$4" n=0 f
  for f in "$dir"/*; do
    put_file "$coll/$(basename "$f")" "$f" "$ctype"
    n=$((n + 1))
  done
  echo "seed-demo: $label — $n items PUT"
}

# --- ensure principal + collections exist (never modify existing ones) --------
ensure_principal() { # <path>
  local code
  code="$(code_of -X PROPFIND -H 'Depth: 0' "$BASE$1")"
  if [ "$code" != "207" ]; then
    code="$(code_of -X MKCOL "$BASE$1")"
    [ "$code" = "201" ] || { echo "seed-demo: MKCOL $1 failed (HTTP $code); is radicale running?" >&2; exit 1; }
    echo "seed-demo: created collection root $1"
  fi
}

calendar_mkcol_body() { # <displayname> <color> [components]
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

ensure_calendar() { # <path> <displayname> <color> [components]
  local code body
  code="$(code_of -X PROPFIND -H 'Depth: 0' "$BASE$1")"
  if [ "$code" != "207" ]; then
    body="$(calendar_mkcol_body "$2" "$3" "${4:-}")"
    code="$(code_of -X MKCOL -H 'Content-Type: application/xml; charset=utf-8' --data-binary "$body" "$BASE$1")"
    [ "$code" = "201" ] || { echo "seed-demo: MKCOL $1 failed (HTTP $code)" >&2; exit 1; }
    echo "seed-demo: created calendar $1 ($2, $3)"
  fi
}

ensure_addressbook() { # <path>
  local code
  code="$(code_of -X PROPFIND -H 'Depth: 0' "$BASE$1")"
  if [ "$code" != "207" ]; then
    code="$(code_of -X MKCOL -H 'Content-Type: application/xml; charset=utf-8' --data-binary '<?xml version="1.0" encoding="utf-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav"><D:set><D:prop><D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype><D:displayname>Contacts</D:displayname></D:prop></D:set></D:mkcol>' "$BASE$1")"
    [ "$code" = "201" ] || { echo "seed-demo: MKCOL $1 failed (HTTP $code)" >&2; exit 1; }
    echo "seed-demo: created addressbook $1 (Contacts)"
  fi
}

# Repair calendars that predate the VEVENT+VTODO MKCOL default (idempotent:
# the PROPPATCH only fires when VTODO is missing from the component set).
repair_comps() { # <path>
  local path="$1" find_body patch_body resp code
  find_body='<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:supported-calendar-component-set/></D:prop></D:propfind>'
  resp="$(curl -s -u "$AUTH" -X PROPFIND -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' --max-time 10 --data-binary "$find_body" "$BASE$path" 2>/dev/null || true)"
  case "$resp" in *'comp name="VTODO"'*) return 0 ;; esac
  patch_body='<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop></D:set></D:propertyupdate>'
  code="$(code_of -X PROPPATCH -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' --max-time 10 --data-binary "$patch_body" "$BASE$path")"
  [ "$code" = "207" ] || { echo "seed-demo: repair $path: PROPPATCH failed (HTTP $code)" >&2; exit 1; }
  echo "seed-demo: repaired $path component-set (now VEVENT+VTODO)"
}

ensure_principal /demo/
ensure_calendar /demo/personal.ics Personal '#fa8d3e'
ensure_calendar /demo/work.ics Work '#55b4d4'
ensure_calendar /demo/family.ics Family '#a37acc'
ensure_calendar /demo/Inbox Inbox '#39bae6' 'VEVENT VTODO'
ensure_calendar /demo/Birthdays Birthdays '#a37acc' 'VEVENT'
ensure_addressbook /demo/contacts/
repair_comps /demo/personal.ics
repair_comps /demo/work.ics
repair_comps /demo/family.ics
repair_comps /demo/Inbox

# --- DELETE sweep: only the old seed-* fixture this script replaces (PUT
# overwrites handle every re-run; arbitrary/user items are never deleted) ------
WIRED=0
sweep() { # <collection> <name>...
  local coll="$1" name code
  shift
  for name in "$@"; do
    code="$(code_of -X DELETE "$BASE$coll/$name")"
    case "$code" in 200|204) WIRED=$((WIRED + 1)) ;; esac
  done
}
sweep /demo/personal.ics seed-001.ics seed-002.ics seed-003.ics seed-004.ics
sweep /demo/work.ics seed-101.ics seed-102.ics seed-103.ics seed-104.ics seed-105.ics seed-106.ics
sweep /demo/family.ics seed-201.ics seed-202.ics seed-203.ics
sweep /demo/contacts seed-301.vcf seed-302.vcf seed-303.vcf seed-304.vcf \
  seed-305.vcf seed-306.vcf seed-307.vcf seed-308.vcf
echo "seed-demo: swept stale items (removed $WIRED)"

# --- generate fixture bodies (fixed demo dates, CRLF, folded at 75 octets) ----
python3 - "$TMP" <<'PY'
import os
import sys

tmp = sys.argv[1]
CRLF = "\r\n"
DTSTAMP = "20261010T000000Z"


def fold(line):  # fold >75 octets, continuation = CRLF + space
    data = line.encode("ascii")
    if len(data) <= 75:
        return line
    chunks = [data[i:i + 74] for i in range(0, len(data), 74)]
    return CRLF.join([chunks[0].decode("ascii")] +
                     [" " + c.decode("ascii") for c in chunks[1:]])


def write(rel, lines):
    path = os.path.join(tmp, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write((CRLF.join(fold(l) for l in lines) + CRLF).encode("ascii"))


def cal(*comps):
    head = ["BEGIN:VCALENDAR", "VERSION:2.0",
            "PRODID:-//wycal//demo fixture 1.0//EN", "CALSCALE:GREGORIAN"]
    return head + [l for c in comps for l in c] + ["END:VCALENDAR"]


def ev(uid, summary, props):
    return (["BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + DTSTAMP,
             "SUMMARY:" + summary] + props + ["END:VEVENT"])


def todo(uid, summary, props):
    return (["BEGIN:VTODO", "UID:" + uid, "DTSTAMP:" + DTSTAMP,
             "SUMMARY:" + summary] + props + ["END:VTODO"])


def vcard(uid, fn, n, props):
    return (["BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + fn,
             "N:" + n] + props + ["END:VCARD"])


# --- personal.ics: p101–p110 --------------------------------------------------
write("personal/p101.ics", cal(ev("p101@wycal", "Morning swim", [
    "DTSTART:20261012T070000",
    "DTEND:20261012T080000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "CATEGORIES:health",
    "X-WYCAL-COLOR:#36c9c6",
    "LOCATION:HKUST pool",
    "DESCRIPTION:Lanes before work.\\nBook a lane: https://example.com/pool-schedule",
])))

write("personal/p102.ics", cal(ev("p102@wycal", "Birthday prep", [
    "DTSTART;TZID=Asia/Hong_Kong:20261015T180000",
    "DTEND;TZID=Asia/Hong_Kong:20261015T200000",
    "CATEGORIES:family",
])))

write("personal/p103.ics", cal(ev("p103@wycal", "Offsite retreat", [
    "DTSTART;VALUE=DATE:20261102",
    "DTEND;VALUE=DATE:20261105",
    "X-WYCAL-COLOR:#f28b82",
    "DESCRIPTION:Offsite retreat agenda:\\nDay 1 - kickoff\\, team charter\\, "
    "roadmap deep dive\\, and a retro of last quarter.\\nDay 2 - workshops: "
    "architecture clinic\\, on-call drills\\, hiring loop calibration\\, and a "
    "long metrics review.\\nDay 3 - boat trip\\, wrap-up\\, and commitments for "
    "the next quarter.\\nPack: sunscreen\\, trainers\\, swimsuit\\, and bug spray.",
])))

write("personal/p104.ics", cal(ev("p104@wycal", "Monthly review", [
    "DTSTART:20261101T100000",
    "DTEND:20261101T110000",
    "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
    "CATEGORIES:work,review",
])))

write("personal/p105.ics", cal(ev("p105@wycal", "One-off dentist", [
    "DTSTART:20261020T093000",
    "DTEND:20261020T100000",
    "STATUS:TENTATIVE",
    "URL:https://example.com/booking",
])))

# p106: recurring event + one override in the SAME file (same UID, RECURRENCE-ID)
write("personal/p106.ics", cal(
    ev("p106@wycal", "Weekly planning", [
        "DTSTART:20261009T160000",
        "DTEND:20261009T170000",
        "RRULE:FREQ=WEEKLY",
        "CATEGORIES:planning",
    ]),
    ev("p106@wycal", "Weekly planning (late)", [
        "RECURRENCE-ID:20261016T160000",
        "DTSTART:20261016T180000",
        "DTEND:20261016T190000",
    ]),
))

write("personal/p107.ics", cal(ev("p107@wycal", "Long ago daily", [
    "DTSTART:20260101T090000",
    "DTEND:20260101T093000",
    "RRULE:FREQ=DAILY;UNTIL=20260301T000000",
    "CATEGORIES:archive",
])))

write("personal/p108.ics", cal(ev("p108@wycal", "ANNIVERSARY", [
    "DTSTART;VALUE=DATE:20261201",
    "RRULE:FREQ=YEARLY",
    "X-WYCAL-COLOR:#d2a6ff",
])))

write("personal/p109.ics", cal(ev("p109@wycal", "Late night deploy", [
    "DTSTART:20261014T230000",
    "DTEND:20261015T003000",
    "CATEGORIES:ops",
])))

write("personal/p110.ics", cal(ev("p110@wycal", "Float (no tz)", [
    "DTSTART:20261013T120000",
    "DTEND:20261013T124500",
])))

# --- work.ics: w201–w204 ------------------------------------------------------
write("work/w201.ics", cal(ev("w201@wycal", "Team standup", [
    "DTSTART:20261012T093000",
    "DTEND:20261012T094500",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    "CATEGORIES:work",
])))

write("work/w202.ics", cal(ev("w202@wycal", "Design review", [
    "DTSTART:20261015T140000",
    "DTEND:20261015T150000",
    "LOCATION:Room 2401",
    "DESCRIPTION:Quarterly design review\\nBring printouts.",
])))

write("work/w203.ics", cal(ev("w203@wycal", "1:1 with manager", [
    "DTSTART:20261015T150000",
    "DTEND:20261015T153000",
    "RRULE:FREQ=WEEKLY;BYDAY=TH",
    "CATEGORIES:work,1:1",
])))

write("work/w204.ics", cal(ev("w204@wycal", "Conference: DevOps Days", [
    "DTSTART;VALUE=DATE:20261028",
    "DTEND;VALUE=DATE:20261030",
    "CATEGORIES:conference,travel",
    "X-WYCAL-COLOR:#59c2ff",
])))

# --- family.ics: f301–f303 ----------------------------------------------------
write("family/f301.ics", cal(ev("f301@wycal", "Family dinner", [
    "DTSTART:20261011T190000",
    "DTEND:20261011T210000",
    "RRULE:FREQ=WEEKLY;BYDAY=SU",
    "CATEGORIES:family",
])))

write("family/f302.ics", cal(ev("f302@wycal", "School pickup", [
    "DTSTART:20261012T153000",
    "DTEND:20261012T155000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH",
])))

write("family/f303.ics", cal(ev("f303@wycal", "Camping trip", [
    "DTSTART;VALUE=DATE:20261114",
    "DTEND;VALUE=DATE:20261117",
])))

# --- Inbox/: t401–t410 (one VTODO per file) -----------------------------------
write("inbox/t401.ics", cal(todo("t401@wycal", "Write wycal README", [
    "PRIORITY:2",
    "CATEGORIES:docs,wycal",
    "DUE:20261015T000000Z",
    "STATUS:IN-PROCESS",
])))

write("inbox/t402.ics", cal(todo("t402@wycal", "Tagged urgent task", [
    "PRIORITY:1",
    "CATEGORIES:inbox,urgent",
    "DUE:20261012T170000Z",
])))

write("inbox/t403.ics", cal(todo("t403@wycal", "Plain starter task", [])))

write("inbox/t404.ics", cal(todo("t404@wycal", "Already done", [
    "STATUS:COMPLETED",
    "COMPLETED:20261008T100000Z",
    "PERCENT-COMPLETE:100",
])))

write("inbox/t405.ics", cal(todo("t405@wycal", "Overdue chore", [
    "PRIORITY:3",
    "CATEGORIES:home",
    "DUE:20260930T000000Z",
])))

write("inbox/t406.ics", cal(todo("t406@wycal", "Far future", [
    "DUE:20261231T000000Z",
    "CATEGORIES:someday",
])))

write("inbox/t407.ics", cal(todo("t407@wycal", "Groceries list", [
    "DESCRIPTION:eggs\\nmilk\\ncoffee",
    "CATEGORIES:errands",
    "PRIORITY:3",
])))

write("inbox/t408.ics", cal(todo("t408@wycal", "Read RFC 5545", [
    "CATEGORIES:learning,no-due",
])))

write("inbox/t409.ics", cal(todo("t409@wycal", "Plan trip to Japan", [
    "CATEGORIES:travel",
    "PRIORITY:2",
    "DUE:20261101T000000Z",
    "DESCRIPTION:flights + ryokan",
])))

write("inbox/t410.ics", cal(todo("t410@wycal", "Recurring chore: water plants", [
    "CATEGORIES:home",
])))

# t411–t418: org-agenda coverage — overdue / due-today / due-this-week DUEs,
# DTSTART-scheduled (org 'scheduled') items without DUE, IN-PROCESS at 40%,
# COMPLETED, #A/#B/#C priority spread, two tags each, and "Next:" action notes.
write("inbox/t411.ics", cal(todo("t411@wycal", "Submit expense report", [
    "PRIORITY:1",
    "CATEGORIES:deep-work,admin",
    "DUE:20261001T170000Z",
    "DESCRIPTION:Beijing trip receipts are in the scanner tray.\\nNext: attach the hotel invoice and submit",
])))

write("inbox/t412.ics", cal(todo("t412@wycal", "Pay water & gas bill", [
    "PRIORITY:5",
    "CATEGORIES:home,errand",
    "DUE:20261011T200000",
    "DESCRIPTION:Due today.\\nNext: pay through the bank app before dinner",
])))

write("inbox/t413.ics", cal(todo("t413@wycal", "Draft Q4 planning doc", [
    "PRIORITY:1",
    "CATEGORIES:deep-work,work",
    "DUE:20261016T000000Z",
    "STATUS:IN-PROCESS",
    "PERCENT-COMPLETE:40",
    "DESCRIPTION:Outline and budget table are done.\\nNext: write the milestones section",
])))

write("inbox/t414.ics", cal(todo("t414@wycal", "Deep-clean the kitchen", [
    "PRIORITY:9",
    "CATEGORIES:home,errand",
    "DTSTART;VALUE=DATE:20261013",
    "DESCRIPTION:Scheduled for Tuesday.\\nNext: buy degreaser on the way home",
])))

write("inbox/t415.ics", cal(todo("t415@wycal", "Review PR #482", [
    "PRIORITY:3",
    "CATEGORIES:deep-work,code",
    "DTSTART:20261012T093000",
    "DESCRIPTION:Scheduled Monday morning.\\nNext: reply to Ivy's threading comments",
])))

write("inbox/t416.ics", cal(todo("t416@wycal", "File tax paperwork", [
    "PRIORITY:5",
    "CATEGORIES:home,admin",
    "STATUS:COMPLETED",
    "COMPLETED:20261009T140000Z",
    "PERCENT-COMPLETE:100",
])))

write("inbox/t417.ics", cal(todo("t417@wycal", "Plan summer offsite", [
    "PRIORITY:5",
    "CATEGORIES:deep-work,travel",
    "DUE:20270301T000000Z",
    "DESCRIPTION:Venue shortlist lives in the scratchpad.\\nNext: collect three quotes",
])))

write("inbox/t418.ics", cal(todo("t418@wycal", "Prepare systems talk", [
    "PRIORITY:7",
    "CATEGORIES:deep-work,learning",
    "DUE:20261020T170000Z",
    "DESCRIPTION:Rough outline in the scratchpad.\\nNext: pick three war stories and one diagram",
])))

# --- contacts/: c501–c508 + c109–c112 (BDAY on c501/c503/c505/c507 + c109–c111,
#     incl. reduced --MMDD; PHOTO;VALUE=URI on c502 + c112) ----------------------
write("contacts/c501.vcf", vcard("c501@wycal", "Alice Chen", "Chen;Alice;;;", [
    "EMAIL;TYPE=WORK:alice.chen@example.com",
    "TEL;TYPE=CELL:+852 9100 0001",
    "ORG:Example Ltd;Engineering",
    "URL:https://example.com/~alice",
    "BDAY:1990-06-15",
]))

write("contacts/c502.vcf", vcard("c502@wycal", "Bob Wong", "Wong;Bob;;;", [
    "EMAIL;TYPE=HOME:bob.wong@example.net",
    "TEL;TYPE=HOME:+852 2300 0002",
    "PHOTO;VALUE=URI:https://placehold.co/96",
    "NOTE:Met at DevOps Days 2025\\, borrowed my soldering iron",
]))

write("contacts/c503.vcf", vcard("c503@wycal", "Carol Lee", "Lee;Carol;;;", [
    "EMAIL;TYPE=WORK:carol.lee@example.com",
    "TEL;TYPE=WORK:+852 3400 0003",
    "ORG:Example Ltd;Design",
    "BDAY:1985-12-03",
    "NOTE:Bring printouts to her reviews",
]))

write("contacts/c504.vcf", vcard("c504@wycal", "David Ng", "Ng;David;;;", [
    "EMAIL;TYPE=HOME:david.ng@example.org",
    "TEL;TYPE=CELL:+852 6500 0004",
    "URL:https://example.org/~david",
]))

write("contacts/c505.vcf", vcard("c505@wycal", "Erin Tam", "Tam;Erin;;;", [
    "EMAIL;TYPE=WORK:erin.tam@example.com",
    "TEL;TYPE=CELL:+852 9800 0005",
    "BDAY:--03-22",
    "NOTE:Prefers morning calls",
]))

write("contacts/c506.vcf", vcard("c506@wycal", "Frank Ho", "Ho;Frank;;;", [
    "EMAIL;TYPE=HOME:frank.ho@example.net",
    "TEL;TYPE=WORK:+852 2700 0006",
    "ORG:HKUST;Pool Office",
]))

write("contacts/c507.vcf", vcard("c507@wycal", "Grace Lam", "Lam;Grace;;;", [
    "EMAIL;TYPE=WORK:grace.lam@example.com",
    "TEL;TYPE=HOME:+852 9700 0007",
    "BDAY:2000-09-08",
    "URL:https://example.com/~grace",
]))

write("contacts/c508.vcf", vcard("c508@wycal", "Henry Yip", "Yip;Henry;;;", [
    "EMAIL;TYPE=HOME:henry.yip@example.org",
    "TEL;TYPE=CELL:+852 9600 0008",
    "NOTE:Neighbour from the 12th floor",
]))

# c109–c112: birthday materializer + rich-record coverage. c109's BDAY lands
# this week (Wed 2026-10-14), c110's later this month; c111 is the reduced
# --MMDD form; c112 has no BDAY but PHOTO/ORG/ROLE/3 emails/2 phones/long NOTE.
write("contacts/c109.vcf", vcard("c109@wycal", "Ivy Zhang", "Zhang;Ivy;;;", [
    "EMAIL;TYPE=WORK:ivy.zhang@example.com",
    "TEL;TYPE=CELL:+852 9500 0109",
    "ORG:Example Ltd;Platform",
    "BDAY:1994-10-14",
    "NOTE:Introduced by Carol at the October meetup",
]))

write("contacts/c110.vcf", vcard("c110@wycal", "Kevin Fong", "Fong;Kevin;;;", [
    "EMAIL;TYPE=HOME:kevin.fong@example.net",
    "TEL;TYPE=CELL:+852 6400 0110",
    "BDAY:1988-10-29",
]))

write("contacts/c111.vcf", vcard("c111@wycal", "Luna Mak", "Mak;Luna;;;", [
    "EMAIL;TYPE=WORK:luna.mak@example.com",
    "TEL;TYPE=WORK:+852 3500 0111",
    "BDAY:--06-15",
    "NOTE:Never remembers my name\\, always remembers my dog's",
]))

write("contacts/c112.vcf", vcard("c112@wycal", "Milo Pau", "Pau;Milo;;;", [
    "PHOTO;VALUE=URI:https://placehold.co/96",
    "ORG:HKUST;Library",
    "ROLE:Systems Librarian",
    "EMAIL;TYPE=HOME:milo.pau@example.org",
    "EMAIL;TYPE=WORK:milo.pau@ust.hk",
    "EMAIL;TYPE=OTHER:milo@pau.dev",
    "TEL;TYPE=CELL:+852 9200 0112",
    "TEL;TYPE=WORK:+852 2800 0112",
    "URL:https://pau.dev",
    "NOTE:Runs the institutional repository\\, co-hosts the monthly repair cafe\\, and keeps a running list of every scanner that has ever wronged him",
]))
PY

# --- PUT everything to stable hrefs -------------------------------------------
put_dir "events personal.ics" personal /demo/personal.ics text/calendar
put_dir "events work.ics"     work     /demo/work.ics     text/calendar
put_dir "events family.ics"   family   /demo/family.ics   text/calendar
put_dir "todos Inbox"         inbox    /demo/Inbox        text/calendar
put_dir "contacts"            contacts /demo/contacts     text/vcard

# --- self-verify ---------------------------------------------------------------
count_items() { # <collection-path>: Depth:1 item count (collection itself excluded)
  curl -s -u "$AUTH" -X PROPFIND -H 'Depth: 1' -H 'Content-Type: application/xml' \
    --data '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>' \
    "$BASE$1" 2>/dev/null \
    | grep -o "<href>$1/[^<]*</href>" | grep -vc "<href>$1/</href>" || true
}

expect() { # <label> <got> <want>
  if [ "$2" = "$3" ]; then
    echo "seed-demo: verify OK  $1 = $2"
  else
    echo "seed-demo: verify FAIL  $1 = $2 (want $3)" >&2
    FAILS=$((FAILS + 1))
  fi
}

cp="$(count_items /demo/personal.ics)"; expect "personal.ics events" "$cp" 10
cw="$(count_items /demo/work.ics)";     expect "work.ics events"     "$cw" 4
cf="$(count_items /demo/family.ics)";   expect "family.ics events"   "$cf" 3
ci="$(count_items /demo/Inbox)";        expect "Inbox todos"         "$ci" 18
cc="$(count_items /demo/contacts)";     expect "contacts"            "$cc" 12

p106="$(curl -s -u "$AUTH" "$BASE/demo/personal.ics/p106.ics")"
expect "p106 VEVENTs (override present)" "$(grep -c '^BEGIN:VEVENT' <<<"$p106")" 2
expect "p106 RECURRENCE-ID present"      "$(grep -c '^RECURRENCE-ID' <<<"$p106")" 1

t413="$(curl -s -u "$AUTH" "$BASE/demo/Inbox/t413.ics")"
expect "t413 IN-PROCESS at 40%" "$(grep -c '^PERCENT-COMPLETE:40' <<<"$t413" || true)" 1
expect "t414 DTSTART-scheduled" "$(curl -s -u "$AUTH" "$BASE/demo/Inbox/t414.ics" | grep -c '^DTSTART;VALUE=DATE:20261013' || true)" 1
expect "t417 far-future DUE"    "$(curl -s -u "$AUTH" "$BASE/demo/Inbox/t417.ics" | grep -c '^DUE:20270301T000000Z' || true)" 1

for c in c501:1990-06-15 c503:1985-12-03 c505:--03-22 c507:2000-09-08 \
         c109:1994-10-14 c110:1988-10-29 c111:--06-15; do
  name="${c%%:*}"; want="${c#*:}"
  got="$(curl -s -u "$AUTH" "$BASE/demo/contacts/$name.vcf" | grep '^BDAY:' | cut -d: -f2- | tr -d '\r' || true)"
  expect "$name BDAY" "$got" "$want"
done
expect "c112 BDAY absent" "$(curl -s -u "$AUTH" "$BASE/demo/contacts/c112.vcf" | grep -c '^BDAY:' || true)" 0

echo "seed-demo: done — personal 10 / work 4 / family 3 events, 18 todos, 12 contacts at $BASE"
if [ "$FAILS" -ne 0 ]; then
  echo "seed-demo: $FAILS failure(s) — see FAIL lines above" >&2
  exit 1
fi
