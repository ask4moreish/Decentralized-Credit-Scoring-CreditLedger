import winston from 'winston';
import { redactSensitiveForLogs } from '../services/privacyService';

const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = redactSensitiveForLogs(info.message) as string;
  }
  const cloned = redactSensitiveForLogs({ ...info }) as Record<string, unknown>;
  Object.assign(info, cloned);
  return info;
});

const logFormat = winston.format.combine(
  redactFormat(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    const cleanText = redactSensitiveForLogs(String(stack || message));
    return `${timestamp} [${String(level).toUpperCase()}]: ${cleanText}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'credit-ledger-backend' },
  transports: [
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    })
  );
}

export const morganStream = {
  write: (message: string) => {
    logger.info(message.trim());
  },
};
