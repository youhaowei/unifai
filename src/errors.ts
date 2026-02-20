export class UnifaiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnifaiError";
  }
}

export class ProviderError extends UnifaiError {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class AbortError extends UnifaiError {
  constructor(message = "Operation was aborted") {
    super(message);
    this.name = "AbortError";
  }
}
