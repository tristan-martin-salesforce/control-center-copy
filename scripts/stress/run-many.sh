#!/bin/zsh
# Run several scenarios one after another; one log per scenario under the private runs dir.
D="$HOME/Library/Application Support/command-center/stress/runs"
mkdir -p "$D"; chmod 700 "$D"
for s in "$@"; do
  CC_NOTIFY=0 npx tsx scripts/stress/run.ts "$s" > "$D/$s.log" 2>&1
  chmod 600 "$D/$s.log"
  grep -E "^(PASS|FAIL|INFO)|^scenario " "$D/$s.log" | grep -v PASS | sed "s/^/[$s] /"
done
