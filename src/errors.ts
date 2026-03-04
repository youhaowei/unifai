export class UnifaiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnifaiError";
  }
}

export class ProviderError extends UnifaiError {
  declare cause?: unknown;

  constructor(
    message: string,
    public readonly provider: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class AbortError extends UnifaiError {
  constructor(message = "Operation was aborted") {
    super(message);
    this.name = "AbortError";
  }
}
