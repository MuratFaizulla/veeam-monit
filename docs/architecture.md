# How it works

[← README](../README.md) · [Documentation](README.md)

```mermaid
flowchart LR
    subgraph VBR["Veeam Backup & Replication"]
        direction TB
        V1["Server 1<br/>REST API :9419"]
        V2["Server 2<br/>REST API :9419"]
    end

    subgraph BOT["Veeam Telegram Monitor · Docker"]
        direction TB
        C["Polling cycle<br/>every 60 s"]
        E["Restore point scan<br/>hourly, selected server"]
        S[("data/telegram-state.json")]
    end

    subgraph TG["Telegram · forum group"]
        direction TB
        A["🚨 Alerts · 🟢 Recovered"]
        L["Live topics<br/>🩺 ▶️ 📅 📈 💾 🛡 🗂"]
        G["General<br/>menu and commands"]
    end

    V1 -- "HTTPS, read only" --> C
    V2 -- "HTTPS, read only" --> C
    V1 -.-> E
    C --> A
    C --> L
    E --> L
    C <--> S
    G -- "/job · /digest · /check" --> C
```

Polling runs at start and then on a timer. Everything the bot must remember across restarts is in `data/telegram-state.json`:

- the last results of jobs, and the runs Veeam is still retrying;
- known chats and topics;
- the IDs of the live messages;
- cooldowns.

After every write a copy, `telegram-state.json.bak`, is saved next to it, and if the main file is damaged the state is restored from the copy.

## Modules and folders

One Nest module per subject, and one folder per module. The folders sit in layers, and every import, between Nest modules and between files alike, goes only down:

```
updates   TelegramUpdatesModule   commands, buttons, webhook, HTTP endpoints
monitor   MonitorModule           polling cycle and alerts; exports only MONITOR
live      LiveModule              live topics: what they say, and one message per topic
estate    EstateModule            restore points, the job card, the digest, runs
veeam     VeeamModule             HTTP client, token, reading Veeam, repository and proxy names
telegram  TelegramModule          delivery: chats, topics, routing, the state file, the bot's language
config                            settings: one declaration per variable
```

Two folders without a module of their own sit in the layers too: `logging` (the file log) at the bottom next to `config`, and `http` (`/api/health` and the API description) at the top next to `updates`. `veeam` and `telegram` are neighbours in one layer and do not import each other.

`test/architecture.test.cjs` fails if an import points up or sideways, or if the application stops building.

## Development

```bash
npm run lint   # TypeScript type check
npm test       # build and run every test (node:test)
```

The tests are written in JavaScript and test the built service, the same code that goes into the image.

**CI** ([.github/workflows/test.yml](../.github/workflows/test.yml)) runs on every push to `main` and on every pull request: the type check and the tests, then the Docker image, built and started the way `docker-compose.yml` starts it (read-only, no capabilities) until Docker calls it healthy. Dependabot proposes library updates once a week, and the workflow checks them like any other change.

**Releases** ([.github/workflows/release.yml](../.github/workflows/release.yml)) are made by pushing a tag:

```bash
npm version 1.1.0 --no-git-tag-version   # package.json and package-lock.json
# CHANGELOG.md: rename [Unreleased] to [1.1.0] — <date>, open a new [Unreleased], fix the links at the bottom
git commit -am "Release 1.1.0"
git tag v1.1.0
git push origin main v1.1.0
```

The tag runs CI again, then publishes the image to `ghcr.io/muratfaizulla/veeam-monit` for amd64 and arm64 (tags `1.1.0`, `1.1`, `1` and `latest`, with provenance and an SBOM) and a GitHub release whose notes are the version's section of the changelog. Nothing is published if the tag differs from `package.json` or the changelog has no section for it. A server with no internet access gets the release with `deploy/offline.sh` or `docker save`/`docker load`; see [getting-started.md](getting-started.md).

The domain glossary (Run, Attempt, Evidence and the other terms of the code) is in [CONTEXT.md](../CONTEXT.md), and the architecture decisions are in [adr/](adr/).
