#!/bin/zsh
set -uo pipefail

label=com.mosh.r8-4b-cont13000
domain="gui/$(/usr/bin/id -u)/$label"
guard_label=com.mosh.r8-4b-cont13000-guard
guard_domain="gui/$(/usr/bin/id -u)/$guard_label"
launchctl_bin=${R8_TAIL_LAUNCHCTL_BIN:-/bin/launchctl}
log=${R8_TAIL_LOG:-/Users/emiliosanchez-harris/r8-4b-cont13000.log}
alert=${R8_TAIL_ALERT:-/Users/emiliosanchez-harris/R8-4B-CONT13000-NAN-ALERT.txt}
exit_alert=${R8_TAIL_EXIT_ALERT:-/Users/emiliosanchez-harris/R8-4B-CONT13000-EXIT-ALERT.txt}
poll_seconds=${R8_TAIL_POLL_SECONDS:-30}

losses_are_finite() {
  /usr/bin/awk '
    /(Train|Val) loss/ {
      for (i = 1; i <= NF; i++) {
        if ($i == "loss") {
          value = $(i + 1)
          sub(/,$/, "", value)
          if (value !~ /^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/) bad = 1
        }
      }
    }
    END { exit bad ? 1 : 0 }
  ' "$1"
}

if [[ "${1:-}" == "--check-log" ]]; then
  losses_are_finite "$2"
  exit $?
fi

while true; do
  state=$("$launchctl_bin" print "$domain" 2>/dev/null | /usr/bin/awk '/state =/ { print $3; exit }')
  [[ "$state" == "running" ]] || break

  if [[ -f "$log" ]] && ! losses_are_finite "$log"; then
    print -r -- "non-finite loss detected $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" > "$alert"
    "$launchctl_bin" bootout "$domain"
    "$launchctl_bin" bootout "$guard_domain"
    exit 2
  fi
  /bin/sleep "$poll_seconds"
done

if ! /usr/bin/grep -q 'Saved final weights' "$log" 2>/dev/null; then
  print -r -- "trainer exited before final weights $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" > "$exit_alert"
fi

"$launchctl_bin" bootout "$guard_domain"
