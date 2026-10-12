#!/usr/bin/env bash
# Provision a local Radicale user for wycal (CONTRACTS.md §19).
#
#   scripts/new-user.sh <user> <pass>
#
# 1. writes a bcrypt htpasswd line into scripts/radicale/users (deduped on
#    username — an existing entry for the same name is replaced, so re-running
#    rotates the password);
# 2. MKCOLs the user's collections, idempotently (PROPFIND-check first, same
#    pattern as scripts/seed.sh):
#      /<user>/  /<user>/Inbox/  /<user>/Birthdays/  /<user>/personal.ics/  /<user>/contacts/
#
# All DAV calls authenticate as the NEW user: the fixture runs rights
# "owner_only", so each principal may only create collections under its own
# home — which is why the htpasswd entry is written before any MKCOL.
#
# The bcrypt hash uses the same venv python one-liner documented in seed.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${WYCAL_DAV_URL:-http://127.0.0.1:5232}"
USERS_FILE="$SCRIPT_DIR/radicale/users"
VENV_PY="$SCRIPT_DIR/radicale/.venv/bin/python"

die() { echo "new-user: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: scripts/new-user.sh <user> <pass>"
USERNAME="$1"
PASSWORD="$2"

# keep it URL-path- and htpasswd-line-safe (also regex-safe for the dedupe)
printf '%s' "$USERNAME" | grep -Eq '^[a-zA-Z0-9_-]+$' \
  || die "username must match [a-zA-Z0-9_-]+ (got: $USERNAME)"
[ -x "$VENV_PY" ] || die "venv python missing at $VENV_PY; see scripts/radicale/start.sh"
[ -f "$USERS_FILE" ] || die "htpasswd file missing at $USERS_FILE"

# --- 1. htpasswd entry (dedupe on username, then append fresh bcrypt) ---------
hash="$("$VENV_PY" -c "import bcrypt, sys; print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt(rounds=12)).decode())" "$PASSWORD")"
tmp="$(mktemp)"
grep -v "^${USERNAME}:" "$USERS_FILE" >"$tmp" || true
printf '%s:%s\n' "$USERNAME" "$hash" >>"$tmp"
mv "$tmp" "$USERS_FILE"
echo "new-user: htpasswd entry written for $USERNAME (bcrypt)"

# --- 2. collections, as the new user ------------------------------------------
AUTH="$USERNAME:$PASSWORD"

code_of() {
  curl -s -u "$AUTH" -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true
}

ensure_principal() { # <path>
  code="$(code_of -X PROPFIND -H 'Depth: 0' "$BASE$1")"
  if [ "$code" != "207" ]; then
    code="$(code_of -X MKCOL "$BASE$1")"
    [ "$code" = "201" ] || die "MKCOL $1 failed (HTTP $code); is radicale running? scripts/radicale/start.sh"
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
  code="$(code_of -X PROPFIND -H 'Depth: 0' "$BASE$1")"
  if [ "$code" != "207" ]; then
    body="$(calendar_mkcol_body "$2" "$3" "${4:-}")"
    code="$(code_of -X MKCOL -H 'Content-Type: application/xml; charset=utf-8' --data-binary "$body" "$BASE$1")"
    [ "$code" = "201" ] || die "MKCOL $1 failed (HTTP $code)"
  fi
}

ensure_addressbook() { # <path>
  code="$(code_of -X PROPFIND -H 'Depth: 0' "$BASE$1")"
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
    code="$(code_of -X MKCOL -H 'Content-Type: application/xml; charset=utf-8' --data-binary "$body" "$BASE$1")"
    [ "$code" = "201" ] || die "MKCOL $1 failed (HTTP $code)"
  fi
}

ensure_principal "/$USERNAME/"
ensure_calendar "/$USERNAME/Inbox/" Inbox '#39bae6' 'VEVENT VTODO'
ensure_calendar "/$USERNAME/Birthdays/" Birthdays '#a37acc'
ensure_calendar "/$USERNAME/personal.ics/" Personal '#fa8d3e'
ensure_addressbook "/$USERNAME/contacts/"

echo "new-user: ok — $USERNAME provisioned at $BASE"
echo "  $BASE/$USERNAME/"
echo "  $BASE/$USERNAME/Inbox/"
echo "  $BASE/$USERNAME/Birthdays/"
echo "  $BASE/$USERNAME/personal.ics/"
echo "  $BASE/$USERNAME/contacts/"
