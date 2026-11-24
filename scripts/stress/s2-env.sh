#!/bin/sh
# STRESS-2 run environment: own spend cap and template, isolated state, no notifications.
export CC_STRESS_CAMPAIGN=STRESS-2
export CC_STRESS_CAP_USD=${CC_STRESS_CAP_USD:-25}
export CC_STRESS_TEMPLATE_DB=control_center_stress_tpl_s2
export CC_STATE_DIR="$HOME/Library/Application Support/command-center/stress/state/s2"
export CC_NOTIFY=0
export CC_TEST_DB_SUFFIX=stress
exec "$@"
