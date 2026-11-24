#!/bin/sh
# STRESS-2 miss bank. Reps run one after another; variants run one at a time (each runs its day shards side by side),
# or side by side when PARALLEL=1 and the 1-min load average is under 20.
#   scripts/stress/run-missbank.sh "1 2 3" "rec tri esc"
cd "$(dirname "$0")/../.." || exit 1
REPS=${1:-"1 2 3"}
VARIANTS=${2:-"rec tri esc"}
LOGS="$HOME/Library/Application Support/command-center/stress/missbank/logs"
mkdir -p "$LOGS" && chmod 700 "$LOGS"
load1() { sysctl -n vm.loadavg | awk '{print int($2)}'; }
for rep in $REPS; do
  for v in $VARIANTS; do
    if [ "${PARALLEL:-0}" = "1" ] && [ "$(load1)" -lt 20 ]; then
      scripts/stress/s2-env.sh npx tsx scripts/stress/missbank.ts run "$v" "$rep" > "$LOGS/$v-$rep.log" 2>&1 &
    else
      scripts/stress/s2-env.sh npx tsx scripts/stress/missbank.ts run "$v" "$rep" > "$LOGS/$v-$rep.log" 2>&1
      echo "$v rep $rep done: $(date +%H:%M) load $(load1)"
    fi
  done
  wait
  chmod 600 "$LOGS"/*.log
  echo "rep $rep done: $(date +%H:%M)"
done
