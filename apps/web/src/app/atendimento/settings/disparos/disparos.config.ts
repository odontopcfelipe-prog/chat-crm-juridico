// Onda 17.56 — Catálogo da Central de Disparos (Fase 1, visual). Baseado no skill
// "disparos-lembretes". Cada disparo segue a anatomia gatilho+condição+canal+
// janela+mensagem; aqui no front guardamos só o que a LISTA e o roteamento do
// editor precisam. Os que já têm backend apontam pra um editor real e pro on/off
// do painel Operacional; o resto entra como catálogo "Em breve" (Fase 2 liga de
// verdade: Prisma Disparo/DisparoLog + BullMQ/DLQ + HSM + anti-spam + opt-out).

export type DisparoCategoria =
  | 'agendamento' | 'pos_consulta' | 'datas' | 'recuperacao' | 'clinico';

export const CATEGORIAS: { id: DisparoCategoria; label: string; color: string }[] = [
  { id: 'agendamento',  label: 'Agendamento',            color: '#7C5CF0' },
  { id: 'pos_consulta', label: 'Pós-consulta',           color: '#14A38B' },
  { id: 'datas',        label: 'Datas e relacionamento', color: '#E8902B' },
  { id: 'recuperacao',  label: 'Recuperação de receita', color: '#F26C1B' },
  { id: 'clinico',      label: 'Clínico e operacional',  color: '#2D7FF9' },
];

/** Editor que abre ao clicar (reusa os painéis existentes). null = sem editor. */
export type DisparoEditor = 'reminders' | 'pos' | 'dentista' | 'confirmacao' | 'reagendamento' | 'aniversario' | null;
/** Chave do GET /followup/operacional → on/off + métrica do disparo. */
export type OperacionalKey = 'confirmacao' | 'lembrete' | 'pos' | 'dentista' | 'aniversario' | 'reagendamento';

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
  { id: 'aniversario', nome: 'Aniversariantes do dia', categoria: 'datas',
    gatilho: 'No aniversário · desejo 00:01 + presente 12h', canal: 'WhatsApp', tags: ['Template', '2 msgs'],
    editor: 'aniversario', operacionalKey: 'aniversario' },
  { id: 'datas_sazonais', nome: 'Datas sazonais', categoria: 'datas',
    gatilho: 'Data fixa da campanha', canal: 'WhatsApp', tags: ['Template'], editor: null, emBreve: true },

  // ── Recuperação de receita (via CRC) ──
  { id: 'orcamento_parado', nome: 'Orçamento parado', categoria: 'recuperacao',
    gatilho: '3 dias sem fechar', canal: 'WhatsApp', tags: ['via CRC'], editor: null, emBreve: true },
  { id: 'recall_preventivo', nome: 'Recall preventivo', categoria: 'recuperacao',
    gatilho: '6 meses sem retornar', canal: 'WhatsApp', tags: ['via CRC'], editor: null, emBreve: true },
  { id: 'cobranca_amigavel', nome: 'Cobrança amigável', categoria: 'recuperacao',
    gatilho: 'Parcela em atraso', canal: 'WhatsApp', tags: ['via CRC'], editor: null, emBreve: true },

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
