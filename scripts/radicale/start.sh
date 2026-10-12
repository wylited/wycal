#!/usr/bin/env bash
# Start the wycal local Radicale fixture on 127.0.0.1:5232 (CONTRACTS.md §1, §9).
# Config and storage live next to this script; relative paths in the config
# resolve from scripts/radicale because we cd there before exec.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec .venv/bin/radicale -C radicale.conf
