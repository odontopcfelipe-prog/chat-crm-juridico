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
export * from './dentist-routing';
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
// Disparos internos à equipe: quem recebe (cadastro da equipe → User.disparos_off)
export * from './disparos-equipe';
// Disparo em áudio (teste): texto→fala com motor, voz, sotaque e velocidade
export * from './audio-disparo';
// F1 do laboratório: tipo de negócio da conta (CLÍNICA × LABORATÓRIO) e quem é lab
export * from './business-type';
// F4 do laboratório: textos do laboratório (setores, cargos e função do chip)
export * from './lab-textos';
export * from './lab-tenants';
// F3 do laboratório: o que a conta de laboratório recebe ao nascer (catálogo, finanças, funil, chaves desligadas)
export * from './lab-defaults';
// Configuração por conta na GlobalSetting: reserva na global antiga só para contas legadas
export * from './conta-legada';
// Pesquisa pós-atendimento (NPS): chave da configuração por conta
export * from './post-care-config';
// F2 parte 3a: chaves da GlobalSetting que valem para toda conta (o laboratório só lê estas)
export * from './globais-plataforma';
