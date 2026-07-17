import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export * from '@prisma/client';
export * from './enums';
export * from './business-hours';
export * from './reminder-config';
export * from './influencer-schedule-utils';
// Onda 17.32.109 — Defaults plantados em cada tenant novo
export * from './tenant-defaults';
// Onda 17.32.115 — Setores + permissoes (5 setores, ~16 permissoes)
export * from './sectors.config';
// Onda 17.56 — normalizacao de numero BR pro WhatsApp (adiciona o 55 no envio)
export * from './phone.util';
// Onda 17.57 — endereco da clinica do tenant -> string pra {local} nos disparos
export * from './address.util';
// Onda 18.17 — templates de cobranca (fonte unica: api edita, worker le)
export * from './cobranca';
// Agenda do Comercial — disparos de agendamento pro LEAD (chip COMERCIAL)
export * from './comercial-agenda';
