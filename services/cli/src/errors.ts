export class CliError extends Error {
  override readonly name = "CliError";
  readonly code: string;
  readonly exitCode: 1 | 2;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    exitCode: 1 | 2 = 2,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}
