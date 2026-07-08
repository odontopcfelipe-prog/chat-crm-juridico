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
  /**
   * Onda 17.60 — CONFIRMAÇÃO (não é lembrete): a mensagem MAIS ANTIGA configurada
   * (ex.: 48h antes) PEDE pra confirmar a presença. A IA processa a resposta
   * ("sim" → CONFIRMADO; "não posso/remarcar" → libera a vaga + oferece horários).
   * Usada quando o lembrete é o de maior antecedência (>=24h) do evento.
   */
  consulta_confirmacao: string;
  /** Lembrete >= 24h antes (só LEMBRA — quem pede confirmação é o consulta_confirmacao) */
  consulta_24h: string;
  /** Lembrete entre 1h e 23h antes (lembrete pratico) */
  consulta_1h: string;
  /** Lembrete < 1h antes ("estamos te esperando") */
  consulta_15min: string;
}

export interface ReminderConfig {
  /**
   * Onda 17.49 — liga/desliga global dos lembretes de agendamento do tenant.
   * Default LIGADO (ausente/undefined = true) pra nao mudar o comportamento
   * de quem ja usa. So desligado (enabled === false) bloqueia o disparo.
   */
  enabled?: boolean;
  default_antecedencias: ReminderAntecedencia[];
  templates: ReminderTemplates;
}

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  enabled: true,
  default_antecedencias: [
    { minutes_before: 2880, channel: 'WHATSAPP' }, // 48h — CONFIRMAÇÃO (pede pra confirmar)
    { minutes_before: 1440, channel: 'WHATSAPP' }, // 24h — lembrete
    { minutes_before: 60, channel: 'WHATSAPP' },   // 1h  — lembrete
    { minutes_before: 15, channel: 'WHATSAPP' },   // 15min — lembrete
  ],
  templates: {
    consulta_confirmacao:
      'Oi {nome}, tudo bem? 😊\n\n' +
      'Aqui é pra confirmar seu atendimento com {dentista}, marcado pro dia *{data}* às *{hora}*.\n' +
      '{local_line}\n' +
      'Posso confirmar sua presença? 🙂 Se surgir algum imprevisto e precisar mudar o horário, é só me avisar que a gente reorganiza pra você.',
    consulta_24h:
      'Oi {nome}! 😊\n\n' +
      'Passando só pra lembrar da sua consulta com {dentista} amanhã, *{data}* às *{hora}*.\n' +
      '{local_line}\n' +
      'Até lá! Qualquer coisa é só chamar por aqui.',
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
 * Onda 18.x — ORTODONTIA por ORDEM DE CHEGADA.
 *
 * Clínicas de ortodontia atendem em FLUXO: vários pacientes no mesmo bloco, sem
 * hora exclusiva — o paciente chega e é atendido por ordem de chegada. Por isso
 * os disparos de ORTO são SEPARADOS da confirmação normal:
 *   - a confirmação de orto avisa que o atendimento é por ordem de chegada
 *     (não promete uma hora exclusiva como a confirmação padrão);
 *   - o lembrete de orto avisa ~1h antes que os portões vão abrir.
 *
 * Ambos valem SÓ pra eventos type=ORTODONTIA e são OPT-IN (default DESLIGADO).
 * Regra de fallback: com a confirmação de orto DESLIGADA, o evento de orto
 * recebe a confirmação NORMAL (a original) — assim nada fica sem confirmação.
 *
 * Persistidos em GlobalSetting (por tenant):
 *   APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE_<tenant> / APPOINTMENT_CONFIRMATION_ORTO_ENABLED_<tenant>
 *   APPOINTMENT_ORTO_REMINDER_TEMPLATE_<tenant>     / APPOINTMENT_ORTO_REMINDER_ENABLED_<tenant>
 *
 * Variáveis: {nome}, {nome_completo}, {dentista}, {data}, {hora}, {local}/{local_line}.
 * ({hora} = horário de ABERTURA do atendimento / dos portões.)
 */
export const DEFAULT_CONFIRMACAO_ORTO =
  'Oi {nome}, tudo bem? 😊\n\n' +
  'Passando pra confirmar seu atendimento de *ortodontia* com {dentista} amanhã, *{data}*, a partir das *{hora}*.\n' +
  '{local_line}\n' +
  '⚠️ O atendimento é *por ordem de chegada* — quanto mais cedo você chegar, mais cedo é atendido(a).\n' +
  'Posso confirmar sua presença? 🙂';

export const DEFAULT_ORTO_REMINDER =
  'Oi {nome}! 👋\n\n' +
  'Passando pra lembrar do seu atendimento de *ortodontia* com {dentista} hoje. ' +
  'Abrimos os portões em cerca de *1 hora* (por volta das *{hora}*).\n' +
  '{local_line}\n' +
  '📌 É *por ordem de chegada* — chegue com antecedência pra garantir um bom lugar na fila. Te esperamos! 💙';

/**
 * Confirmação de agendamento IMEDIATA de ortodontia — sai NA HORA que marca o
 * agendamento (não espera 24h como a `DEFAULT_CONFIRMACAO_ORTO`). É um aviso de
 * "agendamos pra você", já deixando claro que é por ordem de chegada (não promete
 * hora exclusiva). Persistida em APPOINTMENT_ORTO_IMMEDIATE_TEMPLATE_<tenant> /
 * _ENABLED_<tenant>, aplicada no `create()` do CalendarEvent. OPT-IN (default OFF).
 */
export const DEFAULT_ORTO_IMMEDIATE =
  'Olá {nome}! 😊\n\n' +
  'Agendamos seu atendimento de *ortodontia* com {dentista} para *{data}*.\n' +
  '📌 É *por ordem de chegada*, a partir das *{hora}*.\n' +
  '{local_line}\n' +
  'Qualquer dúvida, é só chamar por aqui!';

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

/**
 * Onda 17.49 — Disparo de PARABÉNS pra aniversariantes do dia.
 *
 * Robô diário: no horário configurado manda um WhatsApp de feliz aniversário
 * pra cada paciente ATIVO que faz aniversário hoje. Opt-in (default DESLIGADO)
 * porque é mensagem que vai pro paciente. Dedup por dia via `last_run_date`.
 *
 * Variáveis no template: {nome} (primeiro nome) e {clinica} (nome da clínica).
 *
 * Persistido em GlobalSetting com key BIRTHDAY_GREETING_<tenant_id>.
 */
export interface BirthdayGreetingConfig {
  /** MSG 1 — a CLÁSSICA (a antiga). liga/desliga */
  enabled: boolean;
  /** Horário da msg 1 "HH:MM" (fuso America/Maceio) */
  send_at: string;
  /** Canal — só WHATSAPP por ora (paciente) */
  channel: 'WHATSAPP';
  /** Template da msg 1 com {nome} e {clinica} */
  template: string;
  /** Última data (YYYY-MM-DD, Maceió) em que a msg 1 disparou — dedup diário */
  last_run_date?: string;

  /** MSG 2 — o DESEJO (na virada do dia, ~00:01). Onda 17.61. */
  message2_enabled?: boolean;
  message2_send_at?: string;
  message2_template?: string;
  message2_last_run_date?: string;

  /** MSG 3 — o PRESENTE/oferta (no meio do dia, ~12:00). Onda 17.61. */
  message3_enabled?: boolean;
  message3_send_at?: string;
  message3_template?: string;
  message3_last_run_date?: string;
}

export const DEFAULT_BIRTHDAY_GREETING: BirthdayGreetingConfig = {
  // MSG 1 — a clássica (a antiga), de manhã.
  enabled: false,
  send_at: '09:00',
  channel: 'WHATSAPP',
  template:
    'Feliz aniversário, {nome}! 🎉🎂\n\n' +
    'A equipe da {clinica} deseja um dia maravilhoso pra você. ' +
    'Conte com a gente pra cuidar do seu sorriso! 😁',
  // MSG 2 — o desejo, na virada do dia (00:01 ≈ hora 00).
  message2_enabled: false,
  message2_send_at: '00:00',
  message2_template:
    'Feliz aniversário, {nome}! 🎉\n' +
    'Talvez a gente não tenha conseguido ser o primeiro a te desejar… mas a gente tentou. 😊 ' +
    'Que neste dia tão especial — em que recordamos o dia do seu nascimento — o Senhor Jesus te ' +
    'abençoe cada dia mais. Aproveite muito esse dia maravilhoso!\n' +
    'Com carinho,\n\n' +
    'Equipe {clinica} 🎂',
  // MSG 3 — o presente, no meio do dia.
  message3_enabled: false,
  message3_send_at: '12:00',
  message3_template:
    '{nome}, a gente não poderia deixar essa data passar em branco. 💙\n' +
    'E, do nosso jeito, queríamos te presentear com algo nosso: é com muito carinho que ' +
    'preparamos pra você 50% de desconto em um clareamento dental. ✨🎁\n' +
    'É só responder esta mensagem que a gente agenda pra você. Seu sorriso merece!\n' +
    'Um abraço,\n\n' +
    'Equipe {clinica}',
};
