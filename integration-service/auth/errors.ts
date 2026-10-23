export const AUTH_ERROR_STATUS = {
  AUTH_INVALID: 401,
  AUTH_EXPIRED: 401,
  AUTH_REVOKED: 401,
  AUTH_CONTEXT_CHANGED: 401,
  PRINCIPAL_MAPPING_MISSING: 401,
  AUTH_FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409,
  AUTH_INPUT_INVALID: 400,
  AUTH_UNAVAILABLE: 503,
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_STATUS;

export class AuthError extends Error {
  readonly status: number;

  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
    this.status = AUTH_ERROR_STATUS[code];
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
