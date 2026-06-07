import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export * from '@prisma/client';
export * from './enums';
export * from './business-hours';
export * from './reminder-config';
export * from './influencer-schedule-utils';
// Onda 17.32.109 — Defaults plantados em cada tenant novo
export * from './tenant-defaults';
