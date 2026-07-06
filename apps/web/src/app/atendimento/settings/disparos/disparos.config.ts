// Onda 17.56 — Catálogo da Central de Disparos (Fase 1, visual). Baseado no skill
// "disparos-lembretes". Cada disparo segue a anatomia gatilho+condição+canal+
// janela+mensagem; aqui no front guardamos só o que a LISTA e o roteamento do
// editor precisam. Os que já têm backend apontam pra um editor real e pro on/off
// do painel Operacional; o resto entra como catálogo "Em breve" (Fase 2 liga de
// verdade: Prisma Disparo/DisparoLog + BullMQ/DLQ + HSM + anti-spam + opt-out).

export type DisparoCategoria =
  | 'agendamento' | 'pos_consulta' | 'datas' | 'recuperacao' | 'clinico' | 'financeiro';

export const CATEGORIAS: { id: DisparoCategoria; label: string; color: string }[] = [
  { id: 'agendamento',  label: 'Agendamento',            color: '#7C5CF0' },
  { id: 'financeiro',   label: 'Financeiro (cobrança)',  color: '#10B981' },
  { id: 'pos_consulta', label: 'Pós-consulta',           color: '#14A38B' },
  { id: 'datas',        label: 'Datas e relacionamento', color: '#E8902B' },
  { id: 'recuperacao',  label: 'Recuperação de receita', color: '#F26C1B' },
  { id: 'clinico',      label: 'Clínico e operacional',  color: '#2D7FF9' },
];

// Onda 18.19 — organização por SETOR/chip (Comercial · Clínica · Financeiro),
// espelhando os 3 chips de WhatsApp. Cada categoria mora num setor; a tela
// agrupa por setor no topo. A Clínica é o chip PRINCIPAL: se o chip do setor
// (Comercial/Financeiro) não estiver conectado, o envio cai na Clínica.
export type Setor = 'comercial' | 'clinica' | 'financeiro';

export const SETORES: { id: Setor; label: string; chip: string; color: string; nota: string; principal?: boolean }[] = [
  { id: 'comercial',  label: 'Comercial', chip: 'Comercial', color: '#F26C1B',
    nota: 'Sai pelo chip Comercial. Se ele não estiver conectado, usa o chip principal (Clínica).' },
  { id: 'clinica',    label: 'Clínica',   chip: 'Clínica',   color: '#2D7FF9', principal: true,
    nota: 'Chip principal da clínica — o padrão de tudo que fala com o paciente.' },
  { id: 'financeiro', label: 'Financeiro', chip: 'Financeiro', color: '#10B981',
    nota: 'Sai pelo chip Financeiro. Se ele não estiver conectado, usa o chip principal (Clínica).' },
];

export const CATEGORIA_SETOR: Record<DisparoCategoria, Setor> = {
  agendamento:  'clinica',
  pos_consulta: 'clinica',
  datas:        'clinica',
  clinico:      'clinica',
  recuperacao:  'comercial',
  financeiro:   'financeiro',
};

/** Editor que abre ao clicar (reusa os painéis existentes). null = sem editor. */
export type DisparoEditor = 'reminders' | 'pos' | 'dentista' | 'confirmacao' | 'reagendamento' | 'aniversario' | 'cobranca' | null;
/** Chave do GET /followup/operacional → on/off + métrica do disparo. */
export type OperacionalKey =
  | 'confirmacao' | 'lembrete' | 'pos' | 'dentista' | 'aniversario' | 'reagendamento'
  // Onda 18.16 — cobrança financeira (chip FINANCEIRO). Cada estágio liga/desliga
  // sozinho; o cron do worker varre o que está em aberto e dispara o certo.
  | 'boleto_1d_antes' | 'boleto_no_dia' | 'boleto_atraso_1d' | 'boleto_atraso_15d' | 'boleto_atraso_30d'
  // Onda 18.28 — confirmação de pagamento (por EVENTO: webhook do Asaas quando cai
  // um pagamento). Não é agendada como os boletos; o webhook checa este toggle.
  | 'confirmacao_pagamento';

export interface DisparoItem {
  id: string;
  nome: string;
  categoria: DisparoCategoria;
  gatilho: string;          // resumo curto exibido na linha
  canal: string;            // "WhatsApp" | "Painel"
  tags: string[];           // ['Template', 'via CRC']
  editor: DisparoEditor;    // painel de config (reusa componentes do Follow-up)
  operacionalKey?: OperacionalKey; // on/off + métrica via Operacional
  /** Lembrete: o on/off é a PRESENÇA desta antecedência (minutos) na config do
   *  lembrete (/calendar/reminders/config) — cada lembrete liga/desliga sozinho. */
  antecedenciaMin?: number;
  /** Aniversário: qual das 3 mensagens (1 clássica, 2 desejo, 3 presente). O on/off
   *  liga/desliga o campo enabled/message2_enabled/message3_enabled da config. */
  birthdayMsg?: 1 | 2 | 3;
  emBreve?: boolean;        // ainda sem backend (catálogo)
}

export const DISPAROS: DisparoItem[] = [
  // ── Agendamento ──
  { id: 'confirmacao', nome: 'Confirmação de agendamento', categoria: 'agendamento',
    gatilho: 'Assim que marca o horário', canal: 'WhatsApp', tags: ['Template'],
    editor: 'confirmacao', operacionalKey: 'confirmacao' },
  { id: 'confirmacao_48h', nome: 'Confirmação de presença · 48h antes', categoria: 'agendamento',
    gatilho: '48h antes · pede pra confirmar (responde no WhatsApp)', canal: 'WhatsApp', tags: ['Template', 'Confirma'],
    editor: 'reminders', antecedenciaMin: 2880 },
  { id: 'lembrete_1dia', nome: 'Lembrete · 1 dia antes', categoria: 'agendamento',
    gatilho: '1 dia antes', canal: 'WhatsApp', tags: ['Template'],
    editor: 'reminders', antecedenciaMin: 1440 },
  { id: 'lembrete_1h', nome: 'Lembrete · 1 hora antes', categoria: 'agendamento',
    gatilho: '1 hora antes', canal: 'WhatsApp', tags: ['Template'],
    editor: 'reminders', antecedenciaMin: 60 },
  { id: 'lembrete_15min', nome: 'Lembrete · 15 minutos antes', categoria: 'agendamento',
    gatilho: '15 minutos antes', canal: 'WhatsApp', tags: ['Template'],
    editor: 'reminders', antecedenciaMin: 15 },
  { id: 'reagendamento', nome: 'Aviso de re-agendamento', categoria: 'agendamento',
    gatilho: 'Quando o horário muda', canal: 'WhatsApp', tags: ['Template'],
    editor: 'reagendamento', operacionalKey: 'reagendamento' },

  // ── Financeiro (cobrança) — Onda 18.16 ──
  // Envia pelo chip FINANCEIRO. O cron varre as cobranças em aberto, vê em que
  // estágio cada boleto está (vence amanhã? venceu hoje? atrasou 15 dias?) e, se
  // o estágio estiver ligado, dispara o lembrete + link do boleto. 1 msg por vez,
  // com intervalo de 3-7 min (anti-ban). Cada boleto recebe no máx 1x cada estágio.
  { id: 'boleto_1d_antes', nome: 'Boleto · 1 dia antes do vencimento', categoria: 'financeiro',
    gatilho: 'Vence amanhã · lembrete gentil', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'boleto_1d_antes' },
  { id: 'boleto_no_dia', nome: 'Boleto · no dia do vencimento', categoria: 'financeiro',
    gatilho: 'Vence hoje', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'boleto_no_dia' },
  { id: 'boleto_atraso_1d', nome: 'Cobrança · 1 dia de atraso', categoria: 'financeiro',
    gatilho: '1 dia após vencer · lembrete', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'boleto_atraso_1d' },
  { id: 'boleto_atraso_15d', nome: 'Cobrança · 15 dias de atraso', categoria: 'financeiro',
    gatilho: '15 dias após vencer · firme', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'boleto_atraso_15d' },
  { id: 'boleto_atraso_30d', nome: 'Cobrança · 30 dias de atraso', categoria: 'financeiro',
    gatilho: '30 dias após vencer · negociar', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'boleto_atraso_30d' },
  // Onda 18.28 — por EVENTO (webhook do Asaas), não agendada. Sem editor por ora.
  { id: 'confirmacao_pagamento', nome: 'Confirmação de pagamento', categoria: 'financeiro',
    gatilho: 'Quando o pagamento é confirmado (automático)', canal: 'WhatsApp', tags: ['Template'],
    editor: null, operacionalKey: 'confirmacao_pagamento' },
  { id: 'pre_consulta', nome: 'Orientações de pré-consulta', categoria: 'agendamento',
    gatilho: '1 dia antes · 1ª consulta', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },
  { id: 'reagendamento_falta', nome: 'Reagendamento após falta', categoria: 'agendamento',
    gatilho: 'Logo após no-show', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },

  // ── Pós-consulta ──
  { id: 'nps', nome: 'Como foi a consulta (NPS)', categoria: 'pos_consulta',
    gatilho: '2h depois', canal: 'WhatsApp', tags: [], editor: 'pos', operacionalKey: 'pos' },
  { id: 'cuidados_pos', nome: 'Cuidados pós-procedimento', categoria: 'pos_consulta',
    gatilho: 'Logo após · cirurgia/extração', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },
  { id: 'avaliacao_google', nome: 'Pedir avaliação no Google', categoria: 'pos_consulta',
    gatilho: '1 dia depois · se NPS alto', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },

  // ── Datas e relacionamento ──
  { id: 'aniversario_classica', nome: 'Aniversário · mensagem clássica', categoria: 'datas',
    gatilho: 'No aniversário · 9h', canal: 'WhatsApp', tags: ['Template'],
    editor: 'aniversario', birthdayMsg: 1 },
  { id: 'aniversario_desejo', nome: 'Aniversário · o desejo', categoria: 'datas',
    gatilho: 'Na virada do dia · 00:01', canal: 'WhatsApp', tags: ['Template'],
    editor: 'aniversario', birthdayMsg: 2 },
  { id: 'aniversario_presente', nome: 'Aniversário · o presente', categoria: 'datas',
    gatilho: 'No meio do dia · 12h · oferta', canal: 'WhatsApp', tags: ['Template'],
    editor: 'aniversario', birthdayMsg: 3 },
  { id: 'datas_sazonais', nome: 'Datas sazonais', categoria: 'datas',
    gatilho: 'Data fixa da campanha', canal: 'WhatsApp', tags: ['Template'], editor: null, emBreve: true },

  // ── Recuperação de receita (via CRC) ──
  { id: 'orcamento_parado', nome: 'Orçamento parado', categoria: 'recuperacao',
    gatilho: '3 dias sem fechar', canal: 'WhatsApp', tags: ['via CRC'], editor: null, emBreve: true },
  { id: 'recall_preventivo', nome: 'Recall preventivo', categoria: 'recuperacao',
    gatilho: '6 meses sem retornar', canal: 'WhatsApp', tags: ['via CRC'], editor: null, emBreve: true },

  // ── Clínico e operacional ──
  { id: 'resumo_dentista', nome: 'Resumo diário do dentista', categoria: 'clinico',
    gatilho: 'Toda manhã · agenda do dia', canal: 'WhatsApp', tags: [],
    editor: 'dentista', operacionalKey: 'dentista' },
  { id: 'retorno_especifico', nome: 'Lembrete de retorno específico', categoria: 'clinico',
    gatilho: 'Data marcada · ortô/implante', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },
  { id: 'exame_pronto', nome: 'Resultado/exame pronto', categoria: 'clinico',
    gatilho: 'Quando marcado pronto', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },
  { id: 'alerta_noshow', nome: 'Alerta de no-show (recepção)', categoria: 'clinico',
    gatilho: 'Logo após falta · interno', canal: 'Painel', tags: [], editor: null, emBreve: true },
];
