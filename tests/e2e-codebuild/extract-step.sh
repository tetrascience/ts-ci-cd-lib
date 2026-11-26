#!/usr/bin/env bash
# Prints the `run: |` script of one named step of a workflow file.
# Usage: extract-step.sh <workflow.yml> <step name>
set -euo pipefail

awk -v name="$2" '
  !found {
    line = $0
    sub(/^[[:space:]]*- name: /, "", line)
    if (line != $0 && line == name) found = 1
    next
  }
  !inrun && /^[[:space:]]*- / { exit }
  !inrun && /^[[:space:]]*run: \|[[:space:]]*$/ {
    match($0, /^[[:space:]]*/); key = RLENGTH; inrun = 1; next
  }
  inrun {
    if ($0 ~ /^[[:space:]]*$/) { held = held "\n"; next }
    match($0, /^[[:space:]]*/)
    if (RLENGTH <= key) exit
    if (!body) body = RLENGTH
    printf "%s%s\n", held, substr($0, body + 1); held = ""
  }
' "$1"
