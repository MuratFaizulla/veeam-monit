# Documentation

[← README](../README.md)

| | Document | What it covers |
| --- | --- | --- |
| 🚀 | [Getting started and running it](getting-started.md) | Requirements, first run, running on a server, updating and rolling back |
| 💬 | [Telegram: topics, retries, live messages](telegram.md) | Where alerts land, how the bot counts Veeam's retries, several servers |
| ⌨️ | [Commands and the menu](commands.md) | The bot's commands, the menu under the input field, who can talk to the bot |
| ⚙️ | [Configuration](configuration.md) | Every `.env` variable and its default |
| 🔌 | [HTTP API](http-api.md) | Routes, the admin key, Swagger |
| 🧭 | [How it works](architecture.md) | Diagram, modules and folders, development, CI and releases |
| 🩹 | [Troubleshooting](troubleshooting.md) | Common problems: certificates, locked accounts, topics, commands, live messages |
| 🤝 | [CONTRIBUTING.md](../CONTRIBUTING.md) | How to report a problem and how to send a change |
| 📘 | [CONTEXT.md](../CONTEXT.md) | The domain glossary |
| 🏛 | [adr/](adr/) | Architecture decisions and why they were made |
| 📜 | [CHANGELOG.md](../CHANGELOG.md) | What changed in each version |
| 🔒 | [SECURITY.md](../SECURITY.md) | How to report a vulnerability and what to do if a secret leaks |

The bot itself speaks Russian. Where these pages quote its messages or its buttons, the quote stays in Russian, with the meaning in English next to it.

## Reference material

- **`veeam-openapi.json`** is the REST API specification of **Veeam Backup & Replication**, the API the bot talks to. It is not the description of this service's own API: that one is built from the code and served by the service at `/api/docs`. Nothing in `docs/` goes into the image or is read by the code.
- **`assets/`** holds the logos for the README (Simple Icons, CC0) and, in `screenshots/`, the README's screenshots: rendered by the bot's own code from an invented estate, in a light and a dark version.
