import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Logs how long each of our own endpoints took end to end. Compared against the
 * per-call lines from VeeamHttpService, this shows whether the time is spent
 * upstream or in our own aggregation.
 */
@Injectable()
export class TimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Timing');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const label = `${request.method} ${request.originalUrl}`;
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.log(label, Date.now() - startedAt, 'ok'),
        error: () => this.log(label, Date.now() - startedAt, 'error'),
      }),
    );
  }

  private log(label: string, elapsedMs: number, outcome: 'ok' | 'error'): void {
    const line = `${label} ${outcome} in ${elapsedMs}ms`;
    if (elapsedMs >= 2000) {
      this.logger.warn(`SLOW ${line}`);
    } else {
      this.logger.log(line);
    }
  }
}
