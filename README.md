<p align="center">
  <img src="docs/assets/logo.svg" width="320" alt="Veeam Backup & Replication → Telegram" />
</p>

<h1 align="center">Veeam Telegram Monitor</h1>

<p align="center">Бот, который следит за <a href="https://www.veeam.com/" target="_blank">Veeam Backup &amp; Replication</a> и сам сообщает в <a href="https://telegram.org/" target="_blank">Telegram</a>, что случилось с резервными копиями.</p>

<p align="center">
  <a href="https://github.com/MuratFaizulla/veeam-monit/actions/workflows/test.yml" target="_blank"><img src="https://github.com/MuratFaizulla/veeam-monit/actions/workflows/test.yml/badge.svg" alt="Tests" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.0.0-00B336.svg" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-proprietary-lightgrey.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/Veeam_B%26R-REST_API_1.1_%7C_1.2-00B336?logo=veeam&logoColor=white" alt="Veeam B&R REST API" />
  <img src="https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white" alt="Telegram Bot API" />
  <img src="https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs&logoColor=white" alt="NestJS 10" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose" />
</p>

## Описание

Veeam Telegram Monitor — сервис на <a href="https://nestjs.com/" target="_blank">NestJS</a> и <a href="https://www.typescriptlang.org/" target="_blank">TypeScript</a>. Он опрашивает REST API Veeam Backup & Replication и пишет в группу Telegram, когда задание упало, восстановилось или вот-вот упрётся в место на репозитории.

<p>В группе-форуме бот держит <b>живые темы</b> — сообщения, которые сам обновляет на месте: что выполняется сейчас, что запланировано на сегодня, у каких заданий нет свежих точек восстановления. Ему не нужен публичный адрес: он сам забирает обновления у Telegram и работает из одного контейнера Docker.</p>

## Возможности

- 🚨 **Оповещения** о сбоях, предупреждениях и восстановлении заданий — со списком ВМ, которые не прошли, и причиной от Veeam.
- 🔁 **Повторы Veeam** считаются одним запуском: бот пишет, будет ли следующая попытка, и доводит историю до конца одним сообщением.
- 📌 **Восемь живых тем**: здоровье монитора, выполняющиеся и запланированные задания, скорость, репозитории, защита, точки восстановления, бэкапы без заданий.
- 🛡 **Точки восстановления** проверяются по каждой машине и по обычному ритму задания, а не по голому статусу «Success».
- ⌨️ **Команды и меню** под полем ввода: сводка, карточка любого задания, проверка по запросу.
- 🖥 **Несколько серверов Veeam** в одном боте: оповещения со всех, живые темы — по выбранному.

## Как это выглядит

Оповещение, отрисованное кодом самого бота на тестовых данных:

```text
🔴 SQL_Nightly: ОШИБКА
Результат: ошибка
Было: успешно
Попытка: 1 из 4 · Veeam повторит ≈ сегодня в 03:54
Тип: бэкап ВМ
Последний запуск: сегодня в 03:02
Следующий запуск: завтра в 03:00

Не прошли: 1 из 3
🔴 sql01 — Failed to open VDDK disk [[DATASTORE01] sql01/sql01_1.vmdk] ( is read-only mode - [true] ) / Failed to open disk for read.

С предупреждением: 1 из 3
🟡 app01 — Unable to truncate SQL Server transaction logs.
```

## С чего начать

```bash
cp .env.example .env            # серверы Veeam, учётная запись, токен бота, ID группы
docker compose up -d --build
```

- Требования, первый запуск и работа на сервере — [docs/getting-started.md](docs/getting-started.md) :books:
- Все настройки со значениями по умолчанию — [docs/configuration.md](docs/configuration.md) :books:
- Команды бота и меню — [docs/commands.md](docs/commands.md) :books:
- Темы, повторы Veeam и живые сообщения — [docs/telegram.md](docs/telegram.md) :books:
- HTTP API и Swagger — [docs/http-api.md](docs/http-api.md) :books:
- Как устроен код — [docs/architecture.md](docs/architecture.md) :books:

## Вопросы и ошибки

Если бот молчит, начните с `/status` в General, журнала `logs/backend.log` и `GET /api/health` на сервере. Об ошибках пишите в [Issues](https://github.com/MuratFaizulla/veeam-monit/issues) этого репозитория, что изменилось в каждой версии — в [CHANGELOG.md](CHANGELOG.md).

## Безопасность

Бот только читает Veeam и отвечает только своим группам. Сертификаты Veeam закреплены по отпечатку, ключи короче 32 символов не принимаются, контейнер работает без привилегий, а порт открыт только на самом сервере. Об уязвимостях — не в Issues, а как описано в [SECURITY.md](SECURITY.md); там же — что делать, если утёк секрет.

## Автор

- Автор — [Мурат Файзулла](https://github.com/MuratFaizulla)
- Репозиторий — [MuratFaizulla/veeam-monit](https://github.com/MuratFaizulla/veeam-monit)

## Лицензия

Veeam Telegram Monitor распространяется по [закрытой лицензии](LICENSE): все права защищены.

<sub>Veeam и Veeam Backup & Replication — товарные знаки Veeam Software; проект с ней не связан. Иконки — <a href="https://simpleicons.org">Simple Icons</a> (CC0).</sub>
