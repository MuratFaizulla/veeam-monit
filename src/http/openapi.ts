import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * The published description of this service's HTTP surface.
 *
 * Two named security schemes, because the two protected surfaces are protected
 * by different secrets and confusing them is the likeliest way to be locked out
 * of your own monitor: `adminKey` guards the operator endpoints, and
 * `webhookSecret` is what Telegram itself sends.
 *
 * The path carries the `api` prefix in full: Swagger mounts its own routes on
 * the HTTP adapter directly and `setGlobalPrefix` never reaches them, so a bare
 * 'docs' here would serve the page at /docs while every documented path said
 * /api. The raw document is the same path plus `-json`.
 */

export const DOCS_PATH = 'api/docs';

export const mountOpenApi = (app: INestApplication): void => {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Veeam Telegram Monitor')
      .setDescription(
        [
          'Сервис следит за Veeam Backup & Replication и пишет изменения в Telegram.',
          '',
          'Эти эндпоинты — управление самим мониторингом, а не чтение данных Veeam:',
          'дашборда в этой ветке нет. Всё, кроме `/health` и вебхука Telegram,',
          'требует заголовка `X-Telegram-Admin-Key` со значением `TELEGRAM_ADMIN_KEY`.',
          'Если ключ не задан в конфигурации, эти эндпоинты отвечают 403 всем —',
          'пустой секрет никогда не означает «секрет не нужен».',
        ].join('\n'),
      )
      .setVersion('0.1.0')
      .addApiKey(
        {
          type: 'apiKey',
          in: 'header',
          name: 'X-Telegram-Admin-Key',
          description: 'Значение TELEGRAM_ADMIN_KEY.',
        },
        'adminKey',
      )
      .addApiKey(
        {
          type: 'apiKey',
          in: 'header',
          name: 'X-Telegram-Bot-Api-Secret-Token',
          description:
            'Секрет вебхука: его присылает сам Telegram, значение TELEGRAM_WEBHOOK_SECRET.',
        },
        'webhookSecret',
      )
      .build(),
  );

  SwaggerModule.setup(DOCS_PATH, app, document, {
    customSiteTitle: 'Veeam Telegram Monitor API',
    swaggerOptions: {
      // The admin key is typed once and kept across a page reload, so checking
      // a handful of endpoints in a row is not a handful of re-authentications.
      persistAuthorization: true,
      docExpansion: 'list',
    },
  });
};
