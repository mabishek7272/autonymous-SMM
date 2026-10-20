import winston from 'winston';
import { StreamOptions } from 'morgan';

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

const isDev = process.env.NODE_ENV !== 'production';

const devFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n  ${JSON.stringify(meta, null, 2)}` : '';
    return `[${timestamp}] ${level}: ${message}${stack ? `\n${stack}` : ''}${metaStr}`;
  })
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: isDev ? devFormat : prodFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
    }),
  ],
});

/** Morgan → Winston stream */
export const morganStream: StreamOptions = {
  write: (message: string) => logger.http(message.trim()),
};
