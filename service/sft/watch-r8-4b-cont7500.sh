#!/bin/zsh
set -uo pipefail

label=com.mosh.r8-4b-cont7500
domain="gui/$(/usr/bin/id -u)/$label"
guard_label=com.mosh.r8-4b-cont7500-guard
guard_domain="gui/$(/usr/bin/id -u)/$guard_label"
launchctl_bin=${R8_CONT_LAUNCHCTL_BIN:-/bin/launchctl}
log=${R8_CONT_LOG:-/Users/emiliosanchez-harris/r8-4b-cont7500.log}
alert=${R8_CONT_ALERT:-/Users/emiliosanchez-harris/R8-4B-CONT7500-NAN-ALERT.txt}
exit_alert=${R8_CONT_EXIT_ALERT:-/Users/emiliosanchez-harris/R8-4B-CONT7500-EXIT-ALERT.txt}

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
    if ! "$launchctl_bin" bootout "$domain"; then
      print -r -- "failed to disable keepalive trainer job" >> "$alert"
      exit 3
    fi
    "$launchctl_bin" bootout "$guard_domain"
    exit 2
  fi
  /bin/sleep 30
done

if ! /usr/bin/grep -q 'Saved final weights' "$log" 2>/dev/null; then
  print -r -- "trainer exited before final weights $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" > "$exit_alert"
fi

"$launchctl_bin" bootout "$guard_domain"
