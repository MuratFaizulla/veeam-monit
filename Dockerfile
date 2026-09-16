# syntax=docker/dockerfile:1

# Build and runtime are separated so the image that ships carries no compiler,
# no test runner and no Nest CLI — only what `node dist/main.js` actually opens.

FROM node:20-alpine AS deps
WORKDIR /app
# Copied on their own so the install layer survives every change to src/.
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# A second install, without devDependencies. Pruning the first one in place
# would leave its layer in the image anyway.
FROM node:20-alpine AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
# The bot writes Russian dates in a named zone (TELEGRAM_TIMEZONE), and the
# container's own clock is read whenever that is empty. Both need the zone
# database, which the base image does not carry.
RUN apk add --no-cache tzdata

ENV NODE_ENV=production
WORKDIR /app

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Both are mount points in normal use. Created here so that running without a
# volume still works instead of failing on the first write, and owned by `node`
# because the process does not run as root.
RUN mkdir -p data logs && chown -R node:node /app
USER node

EXPOSE 3000

# Asks only whether this service answers. /api/health returns 200 even when
# Veeam is unreachable, and that is deliberate: a probe that went unhealthy
# because the monitored server is down would restart the monitor exactly when
# it is most needed to report on it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
