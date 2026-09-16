/**
 * Raised for any failed call to the Veeam REST API, so a Veeam refusal is
 * distinguishable from a programming error in a catch block and in a stack
 * trace. Callers read `message` and nothing else.
 *
 * It used to extend Nest's HttpException and remap 401 to 502 so a browser
 * client could tell "your app session died" from "Veeam rejected us". There is
 * no browser client, and no controller lets this error bubble to a response,
 * so the status, the classification getters and the remap had no observer.
 */
export class VeeamApiError extends Error {
  constructor(message: string, readonly upstreamStatus: number | null = null) {
    super(message);
    this.name = 'VeeamApiError';
  }

  /** Bad or unknown credentials: this VBR answers a malformed token with 401. */
  get isUnauthorized(): boolean {
    return this.upstreamStatus === 401;
  }

  /**
   * Veeam would not act on this token — whatever it thinks is wrong with it.
   *
   * 403 belongs here as much as 401. This VBR answers a *malformed* token with
   * 401, and 403 arrives in bursts on every endpoint at once, starting the
   * moment a token is renewed: the server is refusing a token it has just
   * issued. Whatever the reason, the only useful response is the same one —
   * stop using this token and get another.
   *
   * Treating 403 as fatal instead cost 27 minutes of blindness on 15 September:
   * the token was minutes old by the service's own clock, valid for another
   * hour, and so nothing ever asked for a new one. The monitor sat there
   * failing every cycle until somebody restarted the process.
   */
  get isTokenRejected(): boolean {
    return this.upstreamStatus === 401 || this.upstreamStatus === 403;
  }
}
