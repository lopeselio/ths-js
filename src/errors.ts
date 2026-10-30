export class THSError extends Error {
  override name = 'THSError';
}

/** A non-2xx response from the dashboard API, carrying its `{error: {message, status}}` body. */
export class THSApiError extends THSError {
  override name = 'THSApiError';
  readonly status: number;
  readonly path: string;

  constructor(path: string, status: number, message: string) {
    super(`${path} → ${status}: ${message}`);
    this.path = path;
    this.status = status;
  }
}

export class THSRpcError extends THSError {
  override name = 'THSRpcError';
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method} → ${code}: ${message}`);
    this.code = code;
  }
}

export class THSTimeoutError extends THSError {
  override name = 'THSTimeoutError';
}
