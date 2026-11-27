import { pino, type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        '*.token',
        '*.sessionSecret',
        '*.clientSecret',
        '*.registrationToken',
      ],
      censor: '[redacted]',
    },
  });
}
