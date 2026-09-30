# HTTP API

[← README](../README.md) · [Документация](README.md)

Порт сервиса открыт только на самом сервере (`127.0.0.1:3000`). Всё, кроме `/api/health` и webhook, требует ключа администратора в заголовке `X-Telegram-Admin-Key`.

| Маршрут | Доступ | Назначение |
| --- | --- | --- |
| `GET /api/health` | открыт | Видны ли серверы Veeam — без их имён, адресов и ошибок. Всегда 200. |
| `GET /api/telegram/status` | ключ администратора | Состояние интеграции, очереди и монитора. |
| `GET /api/telegram/chats` | ключ администратора | Известные чаты и темы. |
| `GET /api/telegram/routes` | ключ администратора | Действующие правила маршрутизации. |
| `POST /api/telegram/routes/reload` | ключ администратора | Перечитать файл правил. |
| `POST /api/telegram/check` | ключ администратора | Запустить цикл проверки. |
| `POST /api/telegram/test` | ключ администратора | Тестовое событие через маршрутизатор — проверка всего пути доставки. |
| `POST /api/telegram/notify` | ключ администратора | Отправить произвольное объявление. |
| `POST /api/telegram/webhook` | секрет webhook | Входящие обновления Telegram. |

```bash
curl -H "X-Telegram-Admin-Key: $TELEGRAM_ADMIN_KEY" http://127.0.0.1:3000/api/telegram/status
```

## Swagger

Страница с описанием API выключена по умолчанию.

1. Включите `API_DOCS=true` в `.env` и выполните `docker compose up -d --force-recreate`.
2. Откройте туннель SSH со своего компьютера — порт доступен только на сервере:

   ```bash
   ssh -L 3000:127.0.0.1:3000 <пользователь>@<сервер>
   ```

3. Откройте в браузере **http://localhost:3000/api/docs** (JSON — `/api/docs-json`) и нажмите **Authorize**, чтобы вставить ключ администратора.

Когда закончите, верните `API_DOCS=false`.
