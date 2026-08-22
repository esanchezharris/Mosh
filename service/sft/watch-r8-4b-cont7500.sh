#!/bin/zsh
set -uo pipefail

label=com.mosh.r8-4b-cont7500
domain="gui/$(/usr/bin/id -u)/$label"
log=/Users/emiliosanchez-harris/r8-4b-cont7500.log
alert=/Users/emiliosanchez-harris/R8-4B-CONT7500-NAN-ALERT.txt
exit_alert=/Users/emiliosanchez-harris/R8-4B-CONT7500-EXIT-ALERT.txt

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
  state=$(/bin/launchctl print "$domain" 2>/dev/null | /usr/bin/awk '/state =/ { print $3; exit }')
  [[ "$state" == "running" ]] || break

  if [[ -f "$log" ]] && ! losses_are_finite "$log"; then
    print -r -- "non-finite loss detected $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" > "$alert"
    /bin/launchctl kill SIGTERM "$domain"
    exit 2
  fi
  /bin/sleep 30
done

if ! /usr/bin/grep -q 'Saved final weights' "$log" 2>/dev/null; then
  print -r -- "trainer exited before final weights $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" > "$exit_alert"
  exit 1
fi
