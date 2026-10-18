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

// Onda 18.x — régua única de "boleto vencido" (vence hoje NÃO é atraso).
export * from './overdue.util';
// Onda 17.57 — endereco da clinica do tenant -> string pra {local} nos disparos
export * from './address.util';
// Onda 18.17 — templates de cobranca (fonte unica: api edita, worker le)
export * from './cobranca';
// Agenda do Comercial — disparos de agendamento pro LEAD (chip COMERCIAL)
export * from './comercial-agenda';
// Perfil da IA por clínica/chip (nome da assistente, tamanho, tempo de resposta, horários)
export * from './ai-profile';
// Base de Conhecimento da clínica: categorias + filtro de dado interno
export * from './memory-categories';
// Instruções da memória (extração, perfil do paciente, resumo da clínica) + peneira da extração
export * from './memory-prompts';
// Funil geral do CRC: colunas comuns a todos os funis + etapa equivalente entre funis
export * from './pipeline-general';
// Régua de reativação de leads (follow-up do chip Comercial)
export * from './reativacao-leads';
// Triagem não-paciente (IA): categorias + rótulos + janela dos anexos (worker e API)
export * from './nao-paciente';
// Chip do disparo de paciente/lead pela FUNÇÃO (Comercial↔Clínica, nunca Financeiro)
export * from './chip-paciente';
// Disparos de retorno de manutenção (chip da Clínica): catálogo, janelas e textos
export * from './retorno-disparos';
// Campanha manual (Central de Disparos): setores, anexos, público e ordem de envio
export * from './campanha-manual';
// Anexos (fotos/áudio) nos disparos automáticos da Central
export * from './disparo-anexos';
