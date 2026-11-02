/** An error with an HTTP status and a stable machine code (never carries a secret). */
export class IssuerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "IssuerError";
  }
}
