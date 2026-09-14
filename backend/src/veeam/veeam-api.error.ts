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
  constructor(message: string) {
    super(message);
    this.name = 'VeeamApiError';
  }
}
