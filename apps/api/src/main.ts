import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { assertValidEnvironment } from './common/config/env.validation';

async function bootstrap() {
  // Fail fast on missing/weak secrets or unsafe settings, before listening.
  assertValidEnvironment();

  const app = await NestFactory.create(AppModule);
  configureApp(app);

  // Global error filter, rate limiter and BigInt serializer are registered as
  // APP_* providers in AppModule so they apply uniformly, including to
  // exceptions thrown inside guards themselves.

  // The API contract is not public: docs are off in production unless
  // explicitly enabled (and validateEnvironment forbids enabling them there).
  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true') {
    const config = new DocumentBuilder()
      .setTitle('Corporate Banking Platform API')
      .setDescription('Sandbox corporate banking API — no real money movement.')
      .setVersion('0.1.0')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }

  const port = process.env.API_PORT ?? 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port}`);
}

bootstrap();
