// Onda 17.56 — Catálogo da Central de Disparos (Fase 1, visual). Baseado no skill
// "disparos-lembretes". Cada disparo segue a anatomia gatilho+condição+canal+
// janela+mensagem; aqui no front guardamos só o que a LISTA e o roteamento do
// editor precisam. Os que já têm backend apontam pra um editor real e pro on/off
// do painel Operacional; o resto entra como catálogo "Em breve" (Fase 2 liga de
// verdade: Prisma Disparo/DisparoLog + BullMQ/DLQ + HSM + anti-spam + opt-out).

export type DisparoCategoria =
  | 'agendamento' | 'agendamento_comercial' | 'pos_consulta' | 'datas' | 'recuperacao' | 'clinico' | 'financeiro' | 'equipe';

export const CATEGORIAS: { id: DisparoCategoria; label: string; color: string }[] = [
  { id: 'agendamento',  label: 'Agendamento',            color: '#7C5CF0' },
  // Agenda do COMERCIAL — versão dos disparos de agendamento pro LEAD (contato que
  // ainda não é cliente): sai pelo chip Comercial, com texto próprio. Opt-in.
  { id: 'agendamento_comercial', label: 'Agendamento do lead', color: '#F26C1B' },
  { id: 'financeiro',   label: 'Financeiro (cobrança)',  color: '#10B981' },
  { id: 'pos_consulta', label: 'Pós-consulta',           color: '#14A38B' },
  { id: 'datas',        label: 'Datas e relacionamento', color: '#E8902B' },
  { id: 'recuperacao',  label: 'Recuperação de receita', color: '#F26C1B' },
  { id: 'clinico',      label: 'Clínico e operacional',  color: '#2D7FF9' },
  { id: 'equipe',       label: 'Avisos da equipe',       color: '#8B5CF6' },
];

// Onda 18.19 — organização por SETOR/chip (Comercial · Clínica · Financeiro),
// espelhando os 3 chips de WhatsApp. Cada categoria mora num setor; a tela
// agrupa por setor no topo. A Clínica é o chip PRINCIPAL: se o chip do setor
// (Comercial/Financeiro) não estiver conectado, o envio cai na Clínica.
export type Setor = 'comercial' | 'clinica' | 'financeiro' | 'equipe';

export const SETORES: { id: Setor; label: string; chip: string; color: string; nota: string; principal?: boolean }[] = [
  { id: 'comercial',  label: 'Comercial', chip: 'Comercial', color: '#F26C1B',
    nota: 'Sai pelo chip Comercial. Se ele não estiver conectado, usa o chip principal (Clínica).' },
  { id: 'clinica',    label: 'Clínica',   chip: 'Clínica',   color: '#2D7FF9', principal: true,
    nota: 'Chip principal da clínica — o padrão de tudo que fala com o paciente.' },
  { id: 'financeiro', label: 'Financeiro', chip: 'Financeiro', color: '#10B981',
    nota: 'Sai pelo chip Financeiro. Se ele não estiver conectado, usa o chip principal (Clínica).' },
  { id: 'equipe', label: 'Equipe', chip: 'Clínica', color: '#8B5CF6',
    nota: 'Avisos internos para a equipe (não vão pro paciente). Saem pela instância da clínica.' },
];

export const CATEGORIA_SETOR: Record<DisparoCategoria, Setor> = {
  agendamento:  'clinica',
  agendamento_comercial: 'comercial',
  pos_consulta: 'clinica',
  datas:        'clinica',
  clinico:      'clinica',
  recuperacao:  'comercial',
  financeiro:   'financeiro',
  equipe:       'equipe',
};

/** Editor que abre ao clicar (reusa os painéis existentes). null = sem editor. */
export type DisparoEditor = 'reminders' | 'pos' | 'dentista' | 'confirmacao' | 'confirmacao_orto' | 'orto_immediate' | 'orto_reminder' | 'reagendamento' | 'aniversario' | 'cobranca' | 'comercial_agenda' | 'recall' | 'sem_agendamento' | null;
/** Chave do GET /followup/operacional → on/off + métrica do disparo. */
export type OperacionalKey =
  | 'confirmacao' | 'lembrete' | 'pos' | 'dentista' | 'aniversario' | 'reagendamento'
  // Onda 18.16 — cobrança financeira (chip FINANCEIRO). Cada estágio liga/desliga
  // sozinho; o cron do worker varre o que está em aberto e dispara o certo.
  | 'boleto_1d_antes' | 'boleto_no_dia' | 'boleto_atraso_1d' | 'boleto_atraso_15d' | 'boleto_atraso_30d'
  // Onda 18.28 — confirmação de pagamento (por EVENTO: webhook do Asaas quando cai
  // um pagamento). Não é agendada como os boletos; o webhook checa este toggle.
  | 'confirmacao_pagamento'
  // Parte 1 — apresentação do Financeiro no dia seguinte ao fechamento da venda (D+1).
  | 'boleto_intro'
  // Parte 2 — envio dos boletos em PDF/carnê (D+2). Toggle separado da apresentação.
  | 'boleto_delivery'
  // Agenda do COMERCIAL — 6 disparos de agendamento pro LEAD (não-cliente), pelo
  // chip Comercial. Ids = os próprios nomes dos disparos (@crm/shared).
  | 'comercial_confirmacao' | 'comercial_confirmacao_48h' | 'comercial_lembrete_1dia'
  | 'comercial_lembrete_1h' | 'comercial_lembrete_15min' | 'comercial_reagendamento'
  // Fase 3 — recall de revisão (motor maintenance-recall) e alertas de tarefa
  // à equipe (task-alerts-cron). Defaults LIGADOS (os motores já rodavam).
  | 'recall_preventivo' | 'task_alerts'
  // Negociação aprovada — disparo no fechamento da venda (confirma as condições).
  | 'negociacao_aprovada'
  // Envio do PIX (D+0) — card dedicado: manda o copia-e-cola ao fechar venda PIX.
  | 'pix_delivery'
  // Onda 18.x — ortodontia por ordem de chegada (só vale pra eventos ORTODONTIA).
  | 'confirmacao_orto' | 'lembrete_orto_1h' | 'confirmacao_orto_imediata'
  // Onda — Equipe: resumo diário aos adms de pacientes +30d sem agendar / em stand by
  | 'pacientes_sem_agendamento';

export interface DisparoItem {
  id: string;
  nome: string;
  categoria: DisparoCategoria;
  gatilho: string;          // resumo curto exibido na linha
  canal: string;            // "WhatsApp" | "Painel"
  tags: string[];           // ['Template', 'via CRC']
  editor?: DisparoEditor;   // painel de config (reusa componentes do Follow-up).
                            // Ausente = card só-toggle (sem texto editável), ex.: entrega dos boletos.
  operacionalKey?: OperacionalKey; // on/off + métrica via Operacional
  /** Lembrete: o on/off é a PRESENÇA desta antecedência (minutos) na config do
   *  lembrete (/calendar/reminders/config) — cada lembrete liga/desliga sozinho. */
  antecedenciaMin?: number;
  /** Aniversário: qual das 3 mensagens (1 clássica, 2 desejo, 3 presente). O on/off
   *  liga/desliga o campo enabled/message2_enabled/message3_enabled da config. */
  birthdayMsg?: 1 | 2 | 3;
  /** Só-métrica (Central 2.0): card clicável que abre o resumo (pra quem/quando/
   *  status) SEM toggle nem editor — o liga/desliga vive em outro lugar (ex.:
   *  nutrição de leads = por sequência). A métrica vem do DispatchLog pelo id. */
  soMetrica?: boolean;
  emBreve?: boolean;        // ainda sem backend (catálogo)
}

export const DISPAROS: DisparoItem[] = [
  // ── Agendamento ──
  { id: 'confirmacao', nome: 'Confirmação de agendamento', categoria: 'agendamento',
    gatilho: 'Assim que marca o horário', canal: 'WhatsApp', tags: ['Template'],
    editor: 'confirmacao', operacionalKey: 'confirmacao' },
  // Onda 18.x — ORTODONTIA por ordem de chegada (OPT-IN). 3 disparos em ordem
  // cronológica: ao marcar (imediato) → 1 dia antes → 1h antes (portões). Só valem
  // pra eventos ORTODONTIA; a confirmação de orto usa o texto de ordem de chegada
  // (nunca "às {hora}", que contradiz a fila).
  { id: 'confirmacao_orto_imediata', nome: 'Confirmação de agendamento · Ortodontia (na hora)', categoria: 'agendamento',
    gatilho: 'Assim que marca o horário · só ortodontia · ordem de chegada', canal: 'WhatsApp', tags: ['Template', 'Ortô'],
    editor: 'orto_immediate', operacionalKey: 'confirmacao_orto_imediata' },
  { id: 'confirmacao_orto', nome: 'Confirmação de ortodontia · 1 dia antes', categoria: 'agendamento',
    gatilho: '~24h antes (véspera) · só ortodontia · ordem de chegada', canal: 'WhatsApp', tags: ['Template', 'Ortô'],
    editor: 'confirmacao_orto', operacionalKey: 'confirmacao_orto' },
  { id: 'lembrete_orto_1h', nome: 'Lembrete de ortodontia · 1h antes (portões)', categoria: 'agendamento',
    gatilho: '~1h antes de abrir os portões · só ortodontia', canal: 'WhatsApp', tags: ['Template', 'Ortô'],
    editor: 'orto_reminder', operacionalKey: 'lembrete_orto_1h' },
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

  // ── Agendamento do LEAD (chip Comercial) ──
  // Espelho dos disparos de agenda pro contato que AINDA NÃO É CLIENTE: quando o
  // agendamento é de um lead (sem paciente), a mensagem sai pelo chip COMERCIAL com
  // estes textos — no lugar da versão clínica, nunca as duas. Cada um é opt-in
  // (default OFF); desligado, o lead segue recebendo a versão clínica de hoje.
  { id: 'comercial_confirmacao', nome: 'Confirmação de agendamento · lead', categoria: 'agendamento_comercial',
    gatilho: 'Assim que marca o horário · só lead (não-cliente) · chip Comercial', canal: 'WhatsApp', tags: ['Template'],
    editor: 'comercial_agenda', operacionalKey: 'comercial_confirmacao' },
  { id: 'comercial_confirmacao_48h', nome: 'Confirmação de presença · 48h antes · lead', categoria: 'agendamento_comercial',
    gatilho: '48h antes · pede pra confirmar · só lead · chip Comercial', canal: 'WhatsApp', tags: ['Template', 'Confirma'],
    editor: 'comercial_agenda', operacionalKey: 'comercial_confirmacao_48h' },
  { id: 'comercial_lembrete_1dia', nome: 'Lembrete · 1 dia antes · lead', categoria: 'agendamento_comercial',
    gatilho: '1 dia antes · só lead · chip Comercial', canal: 'WhatsApp', tags: ['Template'],
    editor: 'comercial_agenda', operacionalKey: 'comercial_lembrete_1dia' },
  { id: 'comercial_lembrete_1h', nome: 'Lembrete · 1 hora antes · lead', categoria: 'agendamento_comercial',
    gatilho: '1 hora antes · só lead · chip Comercial', canal: 'WhatsApp', tags: ['Template'],
    editor: 'comercial_agenda', operacionalKey: 'comercial_lembrete_1h' },
  { id: 'comercial_lembrete_15min', nome: 'Lembrete · 15 minutos antes · lead', categoria: 'agendamento_comercial',
    gatilho: '15 minutos antes · só lead · chip Comercial', canal: 'WhatsApp', tags: ['Template'],
    editor: 'comercial_agenda', operacionalKey: 'comercial_lembrete_15min' },
  { id: 'comercial_reagendamento', nome: 'Aviso de re-agendamento · lead', categoria: 'agendamento_comercial',
    gatilho: 'Quando o horário muda · só lead · chip Comercial', canal: 'WhatsApp', tags: ['Template'],
    editor: 'comercial_agenda', operacionalKey: 'comercial_reagendamento' },

  // ── Financeiro (cobrança) — Onda 18.16 ──
  // Envia pelo chip FINANCEIRO. O cron varre as cobranças em aberto, vê em que
  // estágio cada boleto está (vence amanhã? venceu hoje? atrasou 15 dias?) e, se
  // o estágio estiver ligado, dispara o lembrete + link do boleto. 1 msg por vez,
  // com intervalo de 3-7 min (anti-ban). Cada boleto recebe no máx 1x cada estágio.
  // Onda 18.31 — Confirmação PRIMEIRO (é por EVENTO: webhook do Asaas quando cai um
  // pagamento). Editável, sai pelo chip Financeiro, só dispara se o toggle estiver ON.
  // Negociação aprovada — no FECHAMENTO da venda, confirma as condições ao paciente
  // (entrada, parcelas, total). Substitui a apresentação; os boletos saem no dia seguinte.
  { id: 'negociacao_aprovada', nome: 'Negociação aprovada · no fechamento', categoria: 'financeiro',
    gatilho: 'Ao aprovar/encaminhar ao financeiro · confirma o que foi vendido + as condições', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'negociacao_aprovada' },
  { id: 'pix_delivery', nome: 'Envio do PIX · código na hora', categoria: 'financeiro',
    gatilho: 'Ao fechar uma venda em PIX (conta Asaas conectada) · manda o copia-e-cola pra pagar na hora', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'pix_delivery' },
  // Fluxo pós-venda em 2 passos, cada um com seu toggle:
  // D+1 (apresentação, texto editável) → D+2 (envio dos boletos em carnê PDF).
  // A apresentação só sai se a ENTREGA também estiver ligada (senão prometeria boleto
  // que não vem). A entrega funciona sozinha, sem a apresentação.
  { id: 'boleto_intro', nome: 'Apresentação · 1 dia após a venda', categoria: 'financeiro',
    gatilho: 'D+1 · o financeiro se apresenta e avisa que amanhã manda os boletos (precisa da entrega ligada)', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'boleto_intro' },
  { id: 'boleto_delivery', nome: 'Envio dos boletos · carnê em PDF', categoria: 'financeiro',
    gatilho: 'D+2 · manda todos os boletos num carnê (1 PDF) pelo chip Financeiro', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'boleto_delivery' },
  { id: 'confirmacao_pagamento', nome: 'Confirmação de pagamento', categoria: 'financeiro',
    gatilho: 'Quando o pagamento é confirmado (automático)', canal: 'WhatsApp', tags: ['Template'],
    editor: 'cobranca', operacionalKey: 'confirmacao_pagamento' },
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
  { id: 'pre_consulta', nome: 'Orientações de pré-consulta', categoria: 'agendamento',
    gatilho: '1 dia antes · 1ª consulta', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },
  { id: 'reagendamento_falta', nome: 'Reagendamento após falta', categoria: 'agendamento',
    gatilho: 'Logo após no-show', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },

  // ── Pós-consulta ──
  { id: 'nps', nome: 'Como foi a consulta (NPS)', categoria: 'pos_consulta',
    gatilho: '2h depois', canal: 'WhatsApp', tags: [], editor: 'pos', operacionalKey: 'pos' },
  { id: 'cuidados_pos', nome: 'Cuidados pós-procedimento', categoria: 'pos_consulta',
    gatilho: 'Logo após · cirurgia/extração', canal: 'WhatsApp', tags: [], editor: null, emBreve: true },
  // Faxina Fase 4: isto JÁ EXISTE dentro do Pós-atendimento — a resposta positiva
  // ao NPS recebe o agradecimento com o convite ao Google (thanks_text). O card
  // fica como ponteiro informativo, não como "Em breve" enganoso.
  { id: 'avaliacao_google', nome: 'Pedir avaliação no Google', categoria: 'pos_consulta',
    gatilho: 'Já incluído no Pós-atendimento: NPS positivo recebe o convite ao Google', canal: 'WhatsApp', tags: ['Incluso no NPS'], editor: null, emBreve: true },

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
  // Follow-up de leads parados — o MOTOR JÁ RODA (nutrição por sequência,
  // followup.processor + cron legado). Card SÓ-MÉTRICA: mostra quantos foram e
  // pra quem, mas o liga/desliga vive nas SEQUÊNCIAS (cada uma tem seu .active),
  // não num toggle único — por isso sem on/off aqui (seria enganoso).
  { id: 'followup_lead', nome: 'Follow-up de leads parados', categoria: 'recuperacao',
    gatilho: 'Nutrição automática de leads que esfriaram · controle por sequência', canal: 'WhatsApp', tags: ['Métrica'],
    soMetrica: true },
  { id: 'orcamento_parado', nome: 'Orçamento parado', categoria: 'recuperacao',
    gatilho: '3 dias sem fechar', canal: 'WhatsApp', tags: ['via CRC'], editor: null, emBreve: true },
  // Recall de revisão — o MOTOR JÁ RODA (maintenance-recall-cron, paced 3-7min):
  // quando a revisão do procedimento (default_revisit_months) está a até 7 dias,
  // convida o paciente a agendar. Antes o card dizia "Em breve" — mentira útil zero.
  // Default LIGADO (o motor sempre rodou); o toggle permite desligar.
  { id: 'recall_preventivo', nome: 'Recall de revisão (limpeza etc.)', categoria: 'clinico',
    gatilho: 'Revisão do procedimento chegando (até 7 dias) · convida a agendar', canal: 'WhatsApp', tags: ['Template'],
    editor: 'recall', operacionalKey: 'recall_preventivo' },

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

  // ── Equipe (avisos internos) ──
  { id: 'pacientes_sem_agendamento', nome: 'Pacientes sem agendamento', categoria: 'equipe',
    gatilho: '+30 dias sem agendar ou em stand by · resumo diário aos adms', canal: 'WhatsApp', tags: ['Interno'],
    editor: 'sem_agendamento', operacionalKey: 'pacientes_sem_agendamento' },
  // Fase 3 — o motor JÁ RODAVA invisível: avisa o RESPONSÁVEL (WhatsApp do usuário)
  // de tarefa vencendo em 30min (individual, a cada 10min) e das vencidas (resumo
  // 8h/14h). Default LIGADO; o toggle permite desligar. Sem editor (texto interno).
  { id: 'task_alerts', nome: 'Alertas de tarefa à equipe', categoria: 'equipe',
    gatilho: 'Tarefa vencendo em 30min · vencidas às 8h/14h · pro responsável', canal: 'WhatsApp', tags: ['Interno'],
    operacionalKey: 'task_alerts' },
];
