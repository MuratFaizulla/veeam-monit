import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error raised for any failed call to the Veeam REST API. It doubles as a Nest
 * HttpException so a controller can let it bubble up: the client then receives
 * the upstream status code together with the message Veeam returned.
 */
export class VeeamApiError extends HttpException {
  readonly upstreamStatus: number | null;
  readonly errorCode?: string;

  constructor(params: {
    message: string;
    status: number;
    upstreamStatus: number | null;
    errorCode?: string;
    path?: string;
  }) {
    super(
      {
        statusCode: params.status,
        message: params.message,
        errorCode: params.errorCode,
        upstreamStatus: params.upstreamStatus,
        path: params.path,
      },
      params.status,
    );
    this.upstreamStatus = params.upstreamStatus;
    this.errorCode = params.errorCode;
  }

  get isUnauthorized(): boolean {
    return this.upstreamStatus === HttpStatus.UNAUTHORIZED;
  }

  get isNotFound(): boolean {
    return this.upstreamStatus === HttpStatus.NOT_FOUND;
  }

  get isForbidden(): boolean {
    return this.upstreamStatus === HttpStatus.FORBIDDEN;
  }

  get isBadRequest(): boolean {
    return this.upstreamStatus === HttpStatus.BAD_REQUEST;
  }
}
