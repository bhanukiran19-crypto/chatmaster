import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { LoggerService } from '@nestjs/common';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import pino, { type Logger as PinoLogger } from 'pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { loadApiEnvironment } from './env.js';

class StructuredNestLogger implements LoggerService {
  constructor(private readonly logger: PinoLogger) {}

  log(message: unknown, ...parameters: unknown[]): void {
    this.write('info', message, parameters);
  }

  error(message: unknown, ...parameters: unknown[]): void {
    this.write('error', message, parameters);
  }

  warn(message: unknown, ...parameters: unknown[]): void {
    this.write('warn', message, parameters);
  }

  debug(message: unknown, ...parameters: unknown[]): void {
    this.write('debug', message, parameters);
  }

  verbose(message: unknown, ...parameters: unknown[]): void {
    this.write('trace', message, parameters);
  }

  fatal(message: unknown, ...parameters: unknown[]): void {
    this.write('fatal', message, parameters);
  }

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    parameters: unknown[],
  ): void {
    const context = parameters.find((parameter) => typeof parameter === 'string');
    const text = message instanceof Error ? message.message : String(message);
    this.logger[level]({ context }, text);
  }
}

async function bootstrap(): Promise<void> {
  const env = loadApiEnvironment();
  const logger = pino({
    level: env.NODE_ENV === 'development' ? 'debug' : 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.token',
        'req.body.otp',
        'req.body.botToken',
        'botToken',
        'refreshToken',
        'accessToken',
        'set-cookie',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new StructuredNestLogger(logger),
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          scriptSrc: ["'none'"],
          styleSrc: ["'none'"],
          imgSrc: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(json({ limit: '16kb', strict: true }));
  app.use(urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }));
  app.use(cookieParser());
  app.enableCors({
    origin: new URL(env.WEB_APP_URL).origin,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
    maxAge: 600,
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const suppliedId = request.get('x-request-id');
    const requestId =
      suppliedId && /^[A-Za-z0-9_-]{1,64}$/.test(suppliedId) ? suppliedId : randomUUID();
    const startedAt = Date.now();
    response.setHeader('X-Request-ID', requestId);
    logger.info({ requestId, method: request.method, path: request.path }, 'request started');
    response.on('finish', () => {
      logger.info(
        {
          requestId,
          method: request.method,
          path: request.path,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
        },
        'request completed',
      );
    });
    next();
  });

  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  process.stderr.write(`API startup failed: ${message}\n`);
  process.exitCode = 1;
});
