#!/usr/bin/env bash
# Watches the bot from outside it, and writes to Telegram itself when the bot
# cannot: a bot that is down says nothing, and the 🩺 topic of a bot that hangs
# only stops changing, which nobody is looking at.
#
# Run by cron on the server the bot runs on, every five minutes:
#   */5 * * * * /home/<user>/veeam-monit-watchdog.sh /home/<user>/veeam-monit
# Keep the copy cron runs outside the checkout, so a deploy does not find the
# checkout changed. `--test` sends one message and changes nothing, to see
# that the token and the chat are read and Telegram is reached.
#
# It asks two things:
#   - does /api/health answer — the process is up and serves;
#   - was the state file written in the last 15 minutes — every cycle that
#     refreshes a live topic writes it, so an old one is a cycle that hangs or
#     a Telegram the bot does not reach. With TELEGRAM_LIVE=false nothing
#     writes it that often: set WATCHDOG_STALE_MIN=0 to ask the first only.
#
# One message when the bot goes down, one every three hours while it stays
# down, and one when it is back. It runs on the same server, so it cannot say
# that the server itself is gone; that takes a check from somewhere else.
set -uo pipefail

dir=${1:?usage: watchdog.sh <project directory> [--test]}
stale_min=${WATCHDOG_STALE_MIN:-15}
remind_min=${WATCHDOG_REMIND_MIN:-180}
flag=${XDG_CACHE_HOME:-$HOME/.cache}/veeam-monit-watchdog.down

# One value of .env, as Compose reads it: without the quotes around it.
setting() {
  sed -n "s/^$1=//p" "$dir/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

token=$(setting TELEGRAM_BOT_TOKEN)
chat=$(setting TELEGRAM_CHAT_IDS | cut -d, -f1 | tr -d ' ')
port=$(setting HOST_PORT)
state=$(setting TELEGRAM_STATE_FILE)
state=${state:-$dir/data/telegram-state.json}
if [ -z "$token" ] || [ -z "$chat" ]; then
  echo "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_IDS is not set in $dir/.env" >&2
  exit 2
fi

# Through a config read from stdin, so the token is in no command line.
say() {
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
    curl -fsS -m 20 --retry 3 --retry-delay 5 -o /dev/null -K - \
      --data-urlencode "chat_id=$chat" --data-urlencode "text=$1"
}

if [ "${2:-}" = --test ]; then
  say "✅ Veeam Telegram Monitor watchdog on $(hostname): this is a test. It will write here if the bot stops answering."
  exit $?
fi

problem=
if ! curl -fsS -m 10 -o /dev/null "http://127.0.0.1:${port:-3000}/api/health"; then
  problem='it does not answer on /api/health'
elif [ "$stale_min" -gt 0 ]; then
  if [ ! -f "$state" ]; then
    problem='its state file is missing'
  else
    age=$(( ($(date +%s) - $(stat -c %Y "$state")) / 60 ))
    [ "$age" -ge "$stale_min" ] && problem="it has not refreshed its topics for $age min"
  fi
fi

if [ -n "$problem" ]; then
  # Said when it goes down, and again only once the reminder is due. The flag
  # is set only once the message got through, so one that did not is tried
  # again on the next run.
  if [ ! -f "$flag" ] || [ -n "$(find "$flag" -mmin "+$remind_min")" ]; then
    say "🔴 Veeam Telegram Monitor on $(hostname) is not working: $problem. Alerts are not being sent. Check: docker compose ps, docker compose logs --tail 100." &&
      mkdir -p "$(dirname "$flag")" && touch "$flag"
  fi
elif [ -f "$flag" ]; then
  say "🟢 Veeam Telegram Monitor on $(hostname) is working again." && rm -f "$flag"
fi
