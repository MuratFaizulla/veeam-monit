import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES } from './types';

/**
 * The request bodies of the Telegram endpoints, declared once.
 *
 * These are classes rather than inline types because a class survives to
 * runtime, which is what lets the published OpenAPI document describe them
 * instead of carrying a second, hand-written copy of the same five fields. The
 * event builders take these types, so there is one list of what a caller may
 * send and it is the list the documentation shows.
 */

export class AnnouncementBody {
  @ApiProperty({
    description: 'Текст сообщения. Отправляется как обычное ручное уведомление.',
    example: 'Плановые работы на СХД с 22:00 до 23:00',
  })
  text!: string;
}

export class ProbeBody {
  @ApiPropertyOptional({
    description: 'Категория события. Определяет, в какую тему оно попадёт.',
    enum: NOTIFICATION_KINDS,
    default: 'job',
  })
  kind?: string;

  @ApiPropertyOptional({
    description: 'Важность. Ниже порога TELEGRAM_SEVERITIES событие не доставляется.',
    enum: NOTIFICATION_SEVERITIES,
    default: 'info',
  })
  severity?: string;

  @ApiPropertyOptional({
    description: 'Имя задания или репозитория. В режиме job определяет тему.',
    example: 'SQL Daily',
  })
  subject?: string;

  @ApiPropertyOptional({
    description: 'Заголовок. По умолчанию — «Проверка маршрутизации Veeam Monitor».',
  })
  title?: string;

  @ApiPropertyOptional({ description: 'Произвольный текст под таблицей полей.' })
  body?: string;
}
