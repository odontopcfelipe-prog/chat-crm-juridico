#!/usr/bin/env node
/**
 * Monta o grafo de injeção do AppModule JÁ COMPILADO (apps/<app>/dist) sem
 * conectar em banco, Redis nem rede.
 *
 * Pega o que o tsc não vê: ciclo de import entre módulos Nest e provider com
 * dependência não resolvida ("Nest can't resolve dependencies of ..."). Foi
 * esse erro que deixou a API de produção em crash loop em out/2026
 * (Conversas ↔ Pacientes ↔ WhatsApp).
 *
 * Uso (depois do `nest build` do app):
 *   node scripts/ci/di-smoke.cjs api
 *   node scripts/ci/di-smoke.cjs worker
 */
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const app = process.argv[2];
if (!['api', 'worker'].includes(app)) {
  console.error('uso: node scripts/ci/di-smoke.cjs api|worker');
  process.exit(2);
}

const appDir = path.resolve(__dirname, '..', '..', 'apps', app);
const modulePath = path.join(appDir, 'dist', 'app.module.js');
if (!fs.existsSync(modulePath)) {
  console.error(`[di-smoke] ${app}: ${modulePath} não existe — rode o nest build do ${app} antes.`);
  process.exit(2);
}

// Env falso: nada aqui pode alcançar produção. NestFactory.create constrói
// todos os providers (é aí que aparece o "can't resolve dependencies") mas só
// chama onModuleInit no listen()/init(), que nunca rodamos — então o Prisma
// não conecta. O modo `preview` NÃO serve: ele não instancia e deixa passar o
// erro do ciclo (testado com o forwardRef do PatientsService removido).
const FAKE_ENV = {
  DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:1/ci',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '1',
  JWT_SECRET: 'ci-di-smoke',
  ENCRYPTION_KEY: 'ci-di-smoke-ci-di-smoke-ci-di-smo',
  // SDKs que exigem a chave no construtor (nenhuma chamada sai daqui).
  OPENAI_API_KEY: 'sk-ci-di-smoke-fake',
  ANTHROPIC_API_KEY: 'sk-ant-ci-di-smoke-fake',
};
for (const [k, v] of Object.entries(FAKE_ENV)) {
  if (!process.env[k]) process.env[k] = v;
}

const appRequire = createRequire(path.join(appDir, 'package.json'));

(async () => {
  const { NestFactory } = appRequire('@nestjs/core');
  const { AppModule } = appRequire(modulePath);
  const nestApp = await NestFactory.create(AppModule, {
    abortOnError: false,
    logger: ['error'],
    bodyParser: false,
  });
  console.log(`[di-smoke] ${app}: grafo de injeção OK (todos os providers construídos)`);
  // Sem close(): ele chamaria onModuleDestroy de quem nunca conectou.
  void nestApp;
  process.exit(0);
})().catch((err) => {
  console.error(`[di-smoke] ${app}: FALHOU ao montar o grafo de injeção`);
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
