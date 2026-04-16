import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SkipThrottle } from '@nestjs/throttler';
import Redis from 'ioredis';
import { Public } from '../../auth/decorators/public.decorator';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  /** GET /health — visao geral rapida */
  @Get()
  async check() {
    const [db, redis] = await Promise.allSettled([
      this.checkDb(),
      this.checkRedis(),
    ]);

    const dbOk = db.status === 'fulfilled';
    const redisOk = redis.status === 'fulfilled';
    const allOk = dbOk && redisOk;

    return {
      status: allOk ? 'ok' : 'degraded',
      uptime: this.formatUptime(),
      timestamp: new Date().toISOString(),
      services: {
        database: dbOk
          ? { status: 'ok', latency: (db as PromiseFulfilledResult<number>).value + 'ms' }
          : { status: 'error', message: (db as PromiseRejectedResult).reason?.message },
        redis: redisOk
          ? { status: 'ok', latency: (redis as PromiseFulfilledResult<number>).value + 'ms' }
          : { status: 'error', message: (redis as PromiseRejectedResult).reason?.message },
      },
    };
  }

  /** GET /health/db — apenas banco */
  @Get('db')
  async checkDatabase() {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const latency = Date.now() - start;

      return {
        status: 'ok',
        latency: `${latency}ms`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Erro de saúde do banco de dados: ${error.message}`);
      return {
        status: 'error',
        message: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // --- helpers ---

  private async checkDb(): Promise<number> {
    const start = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    return Date.now() - start;
  }

  private async checkRedis(): Promise<number> {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const start = Date.now();

    return new Promise<number>((resolve, reject) => {
      const client = new Redis({ host, port, lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 0 });
      client.connect()
        .then(() => client.ping())
        .then(() => {
          const latency = Date.now() - start;
          client.disconnect();
          resolve(latency);
        })
        .catch((err) => {
          client.disconnect();
          reject(err);
        });
    });
  }

  private formatUptime(): string {
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  }
}
