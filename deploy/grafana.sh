#!/usr/bin/env bash
# Ships Prometheus and Grafana to the bot's server, which reaches neither
# Docker Hub nor grafana.com, and starts them beside the bot: what the bot's
# cycles read, charted. See docs/grafana.md.
#
#   deploy/grafana.sh user@host [project directory on the server, default veeam-monit]
#
# Run deploy/offline.sh first, with METRICS_TOKEN in the bot's .env: the bot
# must serve /api/metrics, and the server's checkout must hold deploy/grafana/.
# The images are pulled here and shipped only when the server lacks them, so
# a second run is quick. Nothing of the bot's is changed: its .env is read for
# the token and its container for the network it is on.
set -euo pipefail

target=${1:?usage: deploy/grafana.sh user@host [project directory on the server]}
remote=${2:-veeam-monit}
cd "$(dirname "$0")/.."

# The images the stack names, by their defaults; a server whose
# deploy/grafana/.env names others is told so below rather than started on
# images it does not hold.
images=$(GRAFANA_ADMIN_PASSWORD=unused docker compose -f deploy/grafana/docker-compose.yml --env-file /dev/null config --images)

for image in $images; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
  here=$(docker image inspect -f '{{.Id}}' "$image")
  there=$(ssh "$target" "docker image inspect -f '{{.Id}}' '$image' 2>/dev/null" </dev/null || true)
  if [ "$here" = "$there" ]; then
    echo "$image: already on $target"
  else
    echo "Shipping $image to $target"
    docker save "$image" | gzip -1 | ssh "$target" 'gunzip | docker load -q' >/dev/null
  fi
done

# The rest is read by the server's bash from stdin, so nothing below may read
# stdin itself.
ssh "$target" bash -s -- "$remote" $images <<'REMOTE'
set -euo pipefail
cd "$1"
shift
shipped="$*"

if [ ! -f deploy/grafana/docker-compose.yml ]; then
  echo 'deploy/grafana/ is not in the checkout on the server: run deploy/offline.sh first.' >&2
  exit 1
fi

# The bot's token, as Prometheus is to send it: without a line break, which
# would be part of the token.
token=$(sed -n 's/^METRICS_TOKEN=//p' .env | tail -n 1 | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//')
if [ -z "$token" ]; then
  echo 'METRICS_TOKEN is not set in the bot'"'"'s .env, so /api/metrics is off. Add one' >&2
  echo '(openssl rand -hex 32), restart the bot with `docker compose up -d`, and run this again.' >&2
  exit 1
fi

cd deploy/grafana
umask 077
# Prometheus runs as nobody and must read it: the token opens nothing but the metrics.
printf '%s' "$token" >metrics-token
chmod 644 metrics-token

touch .env
# Grafana's admin password: made once, and said once.
if ! grep -q '^GRAFANA_ADMIN_PASSWORD=.' .env; then
  password=$(openssl rand -hex 16)
  echo "GRAFANA_ADMIN_PASSWORD=$password" >>.env
  echo "Grafana: admin / $password (kept in $PWD/.env)"
fi
# The network the bot is on, which is what Prometheus has to join to reach it.
if ! grep -q '^MONITOR_NETWORK=.' .env; then
  network=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' veeam-telegram-monitor | awk '{print $1}')
  echo "MONITOR_NETWORK=$network" >>.env
fi

wanted=$(docker compose config --images </dev/null)
for image in $wanted; do
  case " $shipped " in
    *" $image "*) ;;
    *) docker image inspect "$image" >/dev/null 2>&1 || { echo "$image is named in deploy/grafana/.env but is not on this server." >&2; exit 1; } ;;
  esac
done

docker compose up -d </dev/null

for _ in $(seq 1 24); do
  scrape=$(docker exec veeam-prometheus wget -qO- 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null | grep -o '"health":"[a-z]*"' | head -n 1 || true)
  [ "$scrape" = '"health":"up"' ] && break
  sleep 5
done
port=$(sed -n 's/^GRAFANA_PORT=//p' .env | tail -n 1)
bind=$(sed -n 's/^GRAFANA_BIND=//p' .env | tail -n 1)
echo "Prometheus scraping the bot: ${scrape:-no answer yet}."
echo "Grafana on ${bind:-127.0.0.1}:${port:-3001} of this server; the overview is its home page."
REMOTE
