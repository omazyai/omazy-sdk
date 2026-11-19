/** A refusal or failure from the Core API. Branch on `code`, log `message`. */
export class OmazyError extends Error {
  override readonly name = 'OmazyError'
  constructor(
    message: string,
    /** HTTP status, or 0 when no response arrived. */
    readonly status: number,
    /** Stable machine code, such as BAD_REQUEST or RATE_LIMIT_EXCEEDED. */
    readonly code: string,
    /** The X-Request-Id of the response. Quote it when reporting a failure. */
    readonly requestId?: string,
    /** Seconds to wait before trying again, when the API said. */
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}
