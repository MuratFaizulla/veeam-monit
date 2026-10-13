#!/usr/bin/env bash
# Builds the bot here and ships it, ready to run, to a server that reaches
# neither npm nor Docker Hub. The server builds nothing: its image is a base
# it already holds with this build's dist and production node_modules copied
# on top (deploy/Dockerfile.bundle).
#
#   deploy/offline.sh user@host [project directory on the server, default veeam-monit]
#
# Every production dependency is JavaScript, so node_modules installed here
# runs on the server's Linux as it is. One that ships a native binary would
# not; the script refuses it rather than ship something that cannot start.
#
# The previous image stays as veeam-telegram-monitor:before-<commit>. To go
# back, on the server:
#   docker tag veeam-telegram-monitor:before-<commit> veeam-telegram-monitor:local
#   docker compose up -d --no-build
set -euo pipefail

target=${1:?usage: deploy/offline.sh user@host [project directory on the server]}
remote=${2:-veeam-monit}
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo 'Commit first: what runs on the server must be a commit of this repository.' >&2
  exit 1
fi
rev=$(git rev-parse --short HEAD)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Building $rev"
npm run build
mkdir "$work/app"
cp -r dist package.json package-lock.json "$work/app/"
(cd "$work/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
if find "$work/app/node_modules" -name '*.node' | grep -q .; then
  echo 'A production dependency ships a native binary; build the image with Docker instead.' >&2
  exit 1
fi
cp deploy/Dockerfile.bundle "$work/app/Dockerfile"

# The system packages the bot needs beyond Node.js, which the server cannot
# fetch either: the browser that prints /repos. The base remembers in a label
# what it was given, so they are fetched here and shipped once, not with every
# version. ALPINE_MIRROR picks a faster mirror than the default.
packages='chromium-headless-shell'
held=$(ssh "$target" "docker image inspect -f '{{index .Config.Labels \"veeam-monit.packages\"}}' veeam-telegram-monitor:base 2>/dev/null" </dev/null || true)
if [ "$held" != "$packages" ]; then
  release=$(ssh "$target" 'docker run --rm --entrypoint cat veeam-telegram-monitor:local /etc/alpine-release' </dev/null)
  installed=$(ssh "$target" 'docker run --rm --entrypoint apk veeam-telegram-monitor:local info' </dev/null | tr '\n' ' ')
  echo "Fetching $packages for Alpine $release, once"
  ALPINE_RELEASE="v${release%.*}" ALPINE_HAVE="$installed" node deploy/alpine-packages.cjs "$work/app/apk" $packages
  echo "$packages" >"$work/app/apk/PACKAGES"
fi
tar -czf "$work/app.tgz" -C "$work/app" Dockerfile package.json dist node_modules $([ -d "$work/app/apk" ] && echo apk)

echo "Shipping $rev to $target:$remote"
# The code too, so the server's checkout says what runs there.
git push --quiet "$target:$remote" "HEAD:refs/heads/incoming"
scp -q "$work/app.tgz" "$target:/tmp/veeam-monit-$rev.tgz"

# The rest is read by the server's bash from stdin, so nothing below may read
# stdin itself: `docker compose run` did, and swallowed the script after it.
ssh "$target" bash -s -- "$remote" "$rev" <<'REMOTE'
set -euo pipefail
cd "$1"
rev=$2
bundle=/tmp/veeam-monit-$rev.tgz
build=$(mktemp -d)
trap 'rm -rf "$build" "$bundle"' EXIT

git merge --quiet --ff-only incoming

# What this script builds is veeam-telegram-monitor:local; a published image
# named in MONITOR_IMAGE would be started instead, and the build ignored.
if [ "$(docker compose config --images </dev/null)" != veeam-telegram-monitor:local ]; then
  echo 'MONITOR_IMAGE is set in .env: the server runs a published image, not what this script builds.' >&2
  exit 1
fi

# The base, made once from the image running now: everything but the app.
if ! docker image inspect veeam-telegram-monitor:base >/dev/null 2>&1; then
  printf 'FROM veeam-telegram-monitor:local\nUSER root\nRUN rm -rf /app/dist /app/node_modules\nUSER node\n' |
    docker build -q -t veeam-telegram-monitor:base - >/dev/null
fi

tar -xzf "$bundle" -C "$build"

# System packages shipped with this version go into the base, once. apk
# checks each one's signature against the keys the image already holds.
if [ -d "$build/apk" ]; then
  printf 'FROM veeam-telegram-monitor:base\nUSER root\nCOPY *.apk /tmp/apk/\nRUN apk add --no-network --no-cache /tmp/apk/*.apk && rm -rf /tmp/apk\nUSER node\nLABEL veeam-monit.packages="%s"\n' \
    "$(cat "$build/apk/PACKAGES")" >"$build/apk/Dockerfile"
  docker tag veeam-telegram-monitor:base "veeam-telegram-monitor:base-before-$rev"
  docker build -q -t veeam-telegram-monitor:base "$build/apk" >/dev/null
  rm -rf "$build/apk"
fi

docker tag veeam-telegram-monitor:local "veeam-telegram-monitor:before-$rev"
docker build -q -t veeam-telegram-monitor:local "$build" >/dev/null

# Settings the new code refuses would stop it at start; the old one keeps running instead.
if ! docker compose run --rm --no-deps -T monitor node -e "require('./dist/config/configuration').readConfig(process.env)" </dev/null; then
  docker tag "veeam-telegram-monitor:before-$rev" veeam-telegram-monitor:local
  echo "The settings in .env do not suit $rev; the running version was left as it is." >&2
  exit 1
fi
docker compose up -d --no-build </dev/null

for _ in $(seq 1 24); do
  health=$(docker inspect -f '{{.State.Health.Status}}' veeam-telegram-monitor)
  [ "$health" = healthy ] && break
  sleep 5
done
echo "Running $rev: $health. The previous image is veeam-telegram-monitor:before-$rev."
REMOTE
