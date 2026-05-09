/**
 * Configuracao customizavel de lembretes de agendamento.
 *
 * Fase 25 (Onda 5e v27) — antes os defaults e templates eram hardcoded
 * em 3 lugares (modal da agenda, IA, worker). Agora admin pode editar
 * via UI. Persistido em GlobalSetting com key REMINDER_CONFIG_<tenant_id>
 * e value JSON serializado dessa interface.
 *
 * Variaveis suportadas nos templates (substituidas por applyTemplate):
 *   {nome}              → primeiro nome do paciente
 *   {nome_completo}     → nome inteiro
 *   {dentista}          → "Dra. Suellen" (encurta sobrenome final)
 *   {dentista_completo} → "Dra. Suellen Passos"
 *   {data}              → "ter 06/05/2026" (pt-BR)
 *   {hora}              → "14:00"
 *   {local}             → endereco da consulta (event.location)
 *   {clinica}           → nome da clinica (de GlobalSetting CLINIC_NAME)
 *   {antecedencia}      → "1 dia" / "1 hora" / "15 minutos"
 */

export interface ReminderAntecedencia {
  /** Minutos antes do evento. Ex: 1440 = 1 dia, 60 = 1 hora */
  minutes_before: number;
  /** WHATSAPP | EMAIL | PUSH */
  channel: string;
}

export interface ReminderTemplates {
  /** Lembrete >= 24h antes (convite a confirmar) */
  consulta_24h: string;
  /** Lembrete entre 1h e 23h antes (lembrete pratico) */
  consulta_1h: string;
  /** Lembrete < 1h antes ("estamos te esperando") */
  consulta_15min: string;
}

export interface ReminderConfig {
  default_antecedencias: ReminderAntecedencia[];
  templates: ReminderTemplates;
}

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  default_antecedencias: [
    { minutes_before: 1440, channel: 'WHATSAPP' },
    { minutes_before: 60, channel: 'WHATSAPP' },
    { minutes_before: 15, channel: 'WHATSAPP' },
  ],
  templates: {
    consulta_24h:
      'Oi {nome}! Tudo bem? 😊\n\n' +
      'Passando aqui só pra lembrar da sua avaliação com {dentista} amanhã, {data}.\n' +
      '{local_line}\n' +
      'Está tudo certo do seu lado? Pode me confirmar pra eu já deixar tudo organizado pra você?',
    consulta_1h:
      'Oi {nome}! 👋\n\n' +
      'Sua avaliação com {dentista} é em cerca de 1 hora ({data}).\n' +
      '{local_line}\n' +
      'Tente chegar uns 10 minutinhos antes pra fazer a fichinha de entrada, beleza? Te esperamos!',
    consulta_15min:
      '{nome}, estamos te esperando! 💙\n\n' +
      'Sua avaliação com {dentista} começa logo ({data}).\n' +
      '{local_line}',
  },
};

/**
 * Aplica substituicao de variaveis num template.
 * {chave} eh substituido pelo valor de vars[chave]; ausentes ficam vazios.
 *
 * Trata especialmente {local_line}: se local foi passado, vira "📍 {local}\n";
 * se nao, vira string vazia (evita linha vazia desnecessaria).
 */
export function applyTemplate(
  template: string,
  vars: Partial<{
    nome: string;
    nome_completo: string;
    dentista: string;
    dentista_completo: string;
    data: string;
    hora: string;
    local: string;
    clinica: string;
    antecedencia: string;
  }>,
): string {
  // Tratamento especial: {local_line} -> "📍 {local}\n" se local existir, vazio caso contrario
  const localLine = vars.local ? `📍 ${vars.local}\n` : '';

  let result = template.replace(/\{local_line\}/g, localLine);

  // Substitui demais variaveis
  result = result.replace(/\{(\w+)\}/g, (match, key) => {
    const v = (vars as any)[key];
    return v !== undefined && v !== null ? String(v) : '';
  });

  // Limpa linhas vazias multiplas (3+ \n viram 2)
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}

/**
 * Helper pra escolher qual template usar baseado em minutes_before.
 * 24h+ → consulta_24h, 1h-23h → consulta_1h, <1h → consulta_15min
 */
export function pickTemplateKey(minutesBefore: number): keyof ReminderTemplates {
  if (minutesBefore >= 1440) return 'consulta_24h';
  if (minutesBefore >= 60) return 'consulta_1h';
  return 'consulta_15min';
}

/**
 * Configuracao do RESUMO DIARIO PRA DENTISTAS — Onda 5e v30 (Fase 25).
 *
 * Diferente dos lembretes por evento (templates acima, voltados a paciente),
 * esse e um disparo unico no inicio do dia, listando todos os atendimentos
 * que o dentista tem no dia.
 *
 * Mensagem fica tipo:
 *   Bom dia, Dra. Suellen!
 *   Sua agenda hoje (qua 06/05) tem 4 pacientes:
 *   - 09:00  Jilfran Batista (Avaliacao)
 *   - 10:00  Jilfran Batista (Avaliacao)
 *   - 14:00  Maria Silva (Procedimento)
 *   - 15:30  Pedro Santos (Retorno)
 *
 * Variaveis suportadas no template (alem de {nome}, {data}, {clinica}):
 *   {qtd}              → numero de atendimentos do dia
 *   {agenda}           → bloco multilinha com cada atendimento
 *
 * Persistido em GlobalSetting com key DENTIST_DAILY_SUMMARY_<tenant_id>.
 */
export interface DentistDailySummaryConfig {
  /** Liga/desliga o disparo automatico diario */
  enabled: boolean;
  /** Horario do disparo no formato "HH:MM" (default 07:00) */
  send_at: string;
  /** Canal de entrega — WHATSAPP usa Evolution API, PUSH via WebSocket */
  channel: 'WHATSAPP' | 'PUSH';
  /** Template da mensagem com variaveis {nome}, {data}, {qtd}, {agenda} */
  template: string;
}

export const DEFAULT_DENTIST_DAILY_SUMMARY: DentistDailySummaryConfig = {
  enabled: false,
  send_at: '07:00',
  channel: 'WHATSAPP',
  template:
    'Bom dia, {nome}! 👋\n\n' +
    'Sua agenda hoje ({data}) tem {qtd} atendimento(s):\n\n' +
    '{agenda}\n\n' +
    'Tenha um excelente dia!',
};
