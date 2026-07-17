/**
 * AGENDA DO COMERCIAL — versão dos disparos de agendamento pro LEAD (contato que
 * ainda NÃO é cliente, atendido pelo chip COMERCIAL).
 *
 * Regra de roteamento (nunca os dois pro mesmo evento):
 *   - evento clínico SEM paciente + lead com is_client=false + toggle comercial da
 *     faixa LIGADO  → sai a versão COMERCIAL (texto abaixo, chip COMERCIAL);
 *   - qualquer outra coisa (paciente, lead já cliente, toggle OFF) → fluxo clínico
 *     atual, intocado (compat total: tudo aqui é opt-in, default OFF).
 *
 * Cada disparo tem TEXTO editável (GlobalSetting comercialAgendaTemplateKey, JSON
 * {template}) e TOGGLE próprio (comercialAgendaEnabledKey === 'true'). Ortodontia
 * fica fora (é tratamento clínico por natureza).
 *
 * Variáveis: {nome} {nome_completo} {dentista} {data} {hora} {local}/{local_line} {clinica}.
 */

export const COMERCIAL_AGENDA_IDS = [
  'comercial_confirmacao',        // assim que marca (imediata)
  'comercial_confirmacao_48h',    // pede confirmação ~48h antes
  'comercial_lembrete_1dia',      // lembrete 1 dia antes
  'comercial_lembrete_1h',        // lembrete 1 hora antes
  'comercial_lembrete_15min',     // lembrete 15 minutos antes
  'comercial_reagendamento',      // quando o horário muda
] as const;

export type ComercialAgendaId = (typeof COMERCIAL_AGENDA_IDS)[number];

export function isComercialAgendaId(s: string): s is ComercialAgendaId {
  return (COMERCIAL_AGENDA_IDS as readonly string[]).includes(s);
}

/** Textos padrão — tom de primeira visita ("sua avaliação"), não de paciente da casa. */
export const DEFAULT_COMERCIAL_AGENDA: Record<ComercialAgendaId, string> = {
  comercial_confirmacao:
    'Olá {nome}! 😊\n\n' +
    'Sua avaliação foi agendada para *{data}* às *{hora}* com {dentista}.\n' +
    '{local_line}\n' +
    'Qualquer dúvida, é só chamar por aqui!',
  comercial_confirmacao_48h:
    'Oi {nome}, tudo bem? 😊\n\n' +
    'Aqui é pra confirmar sua avaliação com {dentista}, marcada pro dia *{data}* às *{hora}*.\n' +
    '{local_line}\n' +
    'Posso confirmar sua presença? 🙂 Se surgir algum imprevisto e precisar mudar o horário, é só me avisar que a gente reorganiza pra você.',
  comercial_lembrete_1dia:
    'Oi {nome}! 😊\n\n' +
    'Passando só pra lembrar da sua avaliação com {dentista} amanhã, *{data}* às *{hora}*.\n' +
    '{local_line}\n' +
    'Até lá! Qualquer coisa é só chamar por aqui.',
  comercial_lembrete_1h:
    'Oi {nome}! 👋\n\n' +
    'Sua avaliação com {dentista} é em cerca de 1 hora ({data}).\n' +
    '{local_line}\n' +
    'Tente chegar uns 10 minutinhos antes pra fazer a fichinha de entrada, beleza? Te esperamos!',
  comercial_lembrete_15min:
    '{nome}, estamos te esperando! 💙\n\n' +
    'Sua avaliação com {dentista} começa logo ({data}).\n' +
    '{local_line}',
  comercial_reagendamento:
    'Olá {nome}! 😊\n\n' +
    'Sua avaliação foi *remarcada* para *{data}* às *{hora}* com {dentista}.\n' +
    '{local_line}\n' +
    'Qualquer dúvida, é só chamar por aqui!',
};

export function defaultComercialAgendaTemplate(id: string): string {
  return (DEFAULT_COMERCIAL_AGENDA as Record<string, string>)[id] || '';
}

/** Key da GlobalSetting do TEXTO (JSON {template}) — API grava, API/worker leem. */
export function comercialAgendaTemplateKey(id: string, tenantId: string): string {
  return `COMERCIAL_AGENDA_TEMPLATE_${id}_${tenantId}`;
}

/** Key da GlobalSetting do TOGGLE ('true' liga; ausente/false = OFF). */
export function comercialAgendaEnabledKey(id: string, tenantId: string): string {
  return `COMERCIAL_AGENDA_ENABLED_${id}_${tenantId}`;
}

/** Faixa do lembrete → id comercial (espelha o pickTemplateKey do fluxo clínico,
 *  com a confirmação de 48h — >=2880min — como faixa própria). */
export function comercialLembreteIdFor(minutesBefore: number): ComercialAgendaId {
  if (minutesBefore >= 2880) return 'comercial_confirmacao_48h';
  if (minutesBefore >= 1440) return 'comercial_lembrete_1dia';
  if (minutesBefore >= 60) return 'comercial_lembrete_1h';
  return 'comercial_lembrete_15min';
}
