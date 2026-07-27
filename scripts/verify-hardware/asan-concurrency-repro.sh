#!/bin/bash
BIN="$1"; LABEL="$2"; ROUNDS="${3:-2}"
export ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:print_stacktrace=1:symbolize=1"
crashes=0; total=0; oob=0
for r in $(seq 1 "$ROUNDS"); do
  pids=()
  for i in 1 2 3 4 5; do
    ( MOSH_SELFTEST_SESSION="asan-$LABEL-r$r-$i" MOSH_SERVICE_PORT=$((9500 + r*10 + i)) \
        "$BIN" --selftest -ApplePersistenceIgnoreState YES > "/tmp/asan-$LABEL-$r-$i.log" 2>&1 ) &
    pids+=($!)
  done
  for idx in 0 1 2 3 4; do
    wait "${pids[$idx]}"; rc=$?
    total=$((total+1))
    [ "$rc" -ne 0 ] && crashes=$((crashes+1))
    grep -q "AddressSanitizer" "/tmp/asan-$LABEL-$r-$((idx+1)).log" 2>/dev/null && oob=$((oob+1))
  done
done
echo "$LABEL: nonzero-exit $crashes/$total | ASan-report $oob/$total"
grep -l "AddressSanitizer" /tmp/asan-$LABEL-*.log 2>/dev/null | head -1 | xargs -I{} sh -c 'echo "--- first ASan report ---"; grep -A6 "ERROR: AddressSanitizer" {} | head -10'
