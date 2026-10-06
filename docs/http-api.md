# HTTP API

[← README](../README.md) · [Documentation](README.md)

The service's port is open on the server itself only (`127.0.0.1:3000`). Everything except `/api/health` and the webhook needs the admin key in the `X-Telegram-Admin-Key` header.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/health` | open | Whether the Veeam servers can be reached, without their names, addresses or errors. Always 200. |
| `GET /api/telegram/status` | admin key | State of the integration, the queues and the monitor. |
| `GET /api/telegram/chats` | admin key | Known chats and topics. |
| `GET /api/telegram/routes` | admin key | The routing rules in effect. |
| `POST /api/telegram/routes/reload` | admin key | Reload the rules file. |
| `POST /api/telegram/check` | admin key | Start a check cycle. |
| `POST /api/telegram/test` | admin key | A test event through the router, to check the whole delivery path. |
| `POST /api/telegram/notify` | admin key | Send an announcement of your own. |
| `POST /api/telegram/webhook` | webhook secret | Incoming Telegram updates. |

```bash
curl -H "X-Telegram-Admin-Key: $TELEGRAM_ADMIN_KEY" http://127.0.0.1:3000/api/telegram/status
```

## Swagger

The page describing the API is off by default.

1. Set `API_DOCS=true` in `.env` and run `docker compose up -d --force-recreate`.
2. Open an SSH tunnel from your own computer, since the port is reachable on the server only:

   ```bash
   ssh -L 3000:127.0.0.1:3000 <user>@<server>
   ```

3. Open **http://localhost:3000/api/docs** in a browser (the JSON is at `/api/docs-json`) and press **Authorize** to paste the admin key.

When you are done, set `API_DOCS=false` again.
