// Stages do menu "Advogado" (Preparação — até o protocolo)
export const LEGAL_STAGES = [
  { id: 'VIABILIDADE',   label: 'Viabilidade',     order: 1 },
  { id: 'DOCUMENTACAO',  label: 'Documentação',    order: 2 },
  { id: 'PETICAO',       label: 'Petição Inicial', order: 3 },
  { id: 'REVISAO',       label: 'Revisão',         order: 4 },
  { id: 'PROTOCOLO',     label: 'Protocolo',       order: 5 },
] as const;

// Stages do menu "Processos" (Acompanhamento — pós-protocolo)
export const TRACKING_STAGES = [
  { id: 'DISTRIBUIDO',         label: 'Distribuído',          order: 1 },
  { id: 'CITACAO',             label: 'Citação/Intimação',    order: 2 },
  { id: 'CONTESTACAO',         label: 'Contestação',          order: 3 },
  { id: 'REPLICA',             label: 'Réplica',              order: 4 },
  { id: 'PERICIA_AGENDADA',    label: 'Perícia Agendada',     order: 5 },
  { id: 'INSTRUCAO',           label: 'Audiência/Instrução',  order: 6 },
  { id: 'ALEGACOES_FINAIS',    label: 'Alegações Finais',     order: 7 },
  { id: 'AGUARDANDO_SENTENCA', label: 'Aguardando Sentença',  order: 8 },
  { id: 'JULGAMENTO',          label: 'Julgamento/Sentença',  order: 9 },
  { id: 'RECURSO',             label: 'Recurso',              order: 10 },
  { id: 'TRANSITADO',          label: 'Trânsito em Julgado',  order: 11 },
  { id: 'EXECUCAO',            label: 'Execução',             order: 12 },
  { id: 'ENCERRADO',           label: 'Encerrado',            order: 13 },
] as const;

export type LegalStageId    = typeof LEGAL_STAGES[number]['id'];
export type TrackingStageId = typeof TRACKING_STAGES[number]['id'];
