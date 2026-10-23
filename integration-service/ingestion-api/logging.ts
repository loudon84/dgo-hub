import type { FastifyServerOptions } from 'fastify';

const REDACTED_HEADERS = ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-source-key'];

export function createHubLoggerOptions(stream?: NodeJS.WritableStream): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: 'info',
    redact: { paths: REDACTED_HEADERS, censor: '[Redacted]' },
    ...(stream ? { stream } : {}),
  } as NonNullable<FastifyServerOptions['logger']>;
}
