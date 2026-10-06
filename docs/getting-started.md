# Установка и эксплуатация

[← README](../README.md) · [Документация](README.md)

## Что нужно

- **Docker с Compose** — или Node.js 22+ и npm.
- Доступ к REST API Veeam Backup & Replication, обычно порт `9419`. Версии API 1.1 и 1.2 бот различает сам.
- Отдельная учётная запись Veeam только для чтения; рекомендуемая роль — **Veeam Backup Viewer**.
- Бот, созданный через [@BotFather](https://t.me/BotFather), и **супергруппа с включёнными темами (форум)**.

> [!TIP]
> Выдайте боту в группе права администратора и право **Manage topics** — тогда он сам создаст недостающие темы. Без этого права сообщения, которым негде жить, попадут в General.

## Первый запуск

**1. Настройте `.env`.** Скопируйте [.env.example](../.env.example) в `.env` и заполните как минимум:

```dotenv
VEEAM_SERVERS=https://veeam01.example.com:9419
VEEAM_MONITOR_USERNAME=svc-veeam-monitor
VEEAM_MONITOR_PASSWORD=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_IDS=-1001234567890
TELEGRAM_ADMIN_KEY=...        # не короче 32 символов: openssl rand -hex 32
```

ID группы подскажет сам бот: запустите его с пустым `TELEGRAM_CHAT_IDS` и напишите в группе `/chatid`. Несколько групп перечисляются через запятую. Все остальные настройки — в [configuration.md](configuration.md).

**2. Запустите.**

```bash
docker compose up -d --build
docker compose logs -f
```

**3. Проверьте.** `GET http://localhost:3000/api/health` покажет, видны ли серверы Veeam. В течение минуты в группе появятся живые темы, а в General — меню.

> [!CAUTION]
> Запускайте **один экземпляр** бота на токен. Два экземпляра (например, Docker и PM2) отбирают друг у друга обновления Telegram (`409 Conflict`) и дублируют каждое оповещение.

## Без Docker

```bash
npm ci
npm run start:dev                      # разработка, с перезапуском при правках
npm run build && npm run start:prod    # собранная версия
```

**PM2 на Windows.** PM2 запускает собранный сервис по [ecosystem.config.cjs](../ecosystem.config.cjs). Команды выполняйте из корня проекта; сначала задайте рабочую папку PM2 для текущего окна PowerShell и используйте её для всех последующих команд:

```powershell
$env:PM2_HOME = Join-Path (Get-Location) '.pm2'
```

```bash
npm ci
npm run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs veeam-telegram-monitor
```

После обновления кода: `npm run build`, затем `pm2 restart veeam-telegram-monitor --update-env`. Остановка — `pm2 stop veeam-telegram-monitor`. Автозапуск после перезагрузки Windows настраивается отдельно.

## Работа на сервере

Все команды — из папки проекта.

| Что нужно | Команда |
| --- | --- |
| Состояние (должно быть `Up … (healthy)`) | `docker compose ps` |
| Журнал в реальном времени | `docker compose logs -f --tail 100` |
| Перезапустить | `docker compose restart` |
| Остановить / запустить | `docker compose stop` / `docker compose start` |
| Память и CPU | `docker stats --no-stream veeam-telegram-monitor` |
| Жив ли сервис | `curl http://127.0.0.1:3000/api/health` |

**Выложить новую версию:**

```bash
git pull
docker compose up -d --build
```

**Вернуться к прошлой версии:** `git checkout v1.0.0 && docker compose up -d --build`; обратно на свежую — `git checkout main`. Все версии — в [CHANGELOG.md](../CHANGELOG.md).

**Поменять настройки:** отредактируйте `.env` и выполните `docker compose up -d --force-recreate`. Обычный `restart` новый `.env` не перечитывает.

Контейнер сам поднимается после перезагрузки сервера (`restart: unless-stopped`). Журнал бота — `logs/backend.log`, журнал Docker ограничен тремя файлами по 10 МБ.

> [!WARNING]
> **Не удаляйте `data/`.** Без неё бот опубликует вторую копию всех живых тем и заново оповестит о старых сбоях. Для защиты от потери диска копируйте `data/telegram-state.json` и `.bak` на другой носитель.

Если у сервера нет доступа к Docker Hub, базовый образ `node:22-alpine` загружают вручную (`docker load`). Не заменяйте его потом через `docker pull`.

**Сервер без интернета** (нет ни GitHub, ни npm, ни Docker Hub). Новая версия собирается на компьютере с интернетом и переносится готовой. Из корня проекта, в Git Bash или Linux, после коммита:

```bash
deploy/offline.sh user@host            # папка проекта на сервере по умолчанию — ~/veeam-monit
```

Скрипт собирает `dist` и устанавливает библиотеки здесь, отправляет коммит и архив на сервер по SSH. Там образ собирается простым копированием поверх базы, которую сервер уже держит (Node.js и часовые пояса), проверяются настройки и перезапускается контейнер. Обновления библиотек проходят так же. Прошлый образ остаётся как `veeam-telegram-monitor:before-<коммит>`; вернуться к нему:

```bash
docker tag veeam-telegram-monitor:before-<коммит> veeam-telegram-monitor:local
docker compose up -d --no-build
```

На таком сервере не запускайте `docker compose up -d --build`: сборка пойдёт за пакетами в интернет и упадёт.

Если оповещения не приходят: `/status` в General, журнал `logs/backend.log`, затем `POST /api/telegram/test` — см. [http-api.md](http-api.md).
