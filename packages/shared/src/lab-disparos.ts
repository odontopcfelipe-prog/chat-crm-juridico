/**
 * F7 do laboratório — o que a Central de Disparos do laboratório mostra e aceita.
 * Usado pelo web (filtro dos cards) e pela API (recusa no servidor). Os textos ficam
 * em lab-disparos-textos.ts.
 *
 * Negação por padrão: card ou liga/desliga que não está aqui não existe no
 * laboratório. A régua de cobrança nasce desligada e só roda na conta que ligou o
 * marco (chave ausente = desligado; quem lê é o worker e o BoletoDeliveryService).
 *
 * Módulo puro (sem Prisma, sem Nest).
 */
import { COBRANCA_STAGES, DEFAULT_CONFIRMACAO_PAGAMENTO, isCobrancaStage, type CobrancaTipo } from './cobranca';
import { LAB_NEGOCIACAO, LAB_REGUA } from './lab-disparos-textos';

/** Cards da Central (id de disparos.config.ts do web) que aparecem no laboratório. */
export const DISPAROS_VISIVEIS_NO_LABORATORIO: ReadonlySet<string> = new Set<string>([
  // coleta, prova e entrega
  'confirmacao',
  'confirmacao_48h',
  'lembrete_1dia',
  'reagendamento',
  // venda e cobrança
  'negociacao_aprovada',
  'negociacao_aprovada_avista',
  'confirmacao_pagamento',
  'boleto_intro',
  'boleto_delivery',
  'boleto_1d_antes',
  'boleto_no_dia',
  'boleto_atraso_1d',
  'boleto_atraso_2d',
  'boleto_atraso_3d',
  'boleto_atraso_15d',
  'boleto_atraso_30d',
  'boleto_atrasado',
  'block_sched_on_overdue',
  // relacionamento e equipe
  'aniversario_classica',
  'resumo_dentista',
  'resumo_diario',
  'venda_feita',
  'admin_agendamento_equipe',
]);

/**
 * A régua de cobrança: os marcos (COBRANCA_STAGES), a apresentação e o envio dos boletos.
 * O id do card, o `which` do liga/desliga, o texto editável e o Testar têm o mesmo nome.
 */
export const REGUA_DO_LABORATORIO: ReadonlySet<string> = new Set<string>([
  ...COBRANCA_STAGES,
  'boleto_intro',
  'boleto_delivery',
]);

/**
 * Valores de `which` do PATCH /followup/operacional/toggle que o laboratório liga e
 * desliga (os mesmos do switch de setOperacionalToggle e do operacionalKey dos cards).
 */
export const TOGGLES_DO_LABORATORIO: ReadonlySet<string> = new Set<string>([
  'confirmacao',
  'lembrete',
  'reagendamento',
  'dentista',
  'aniversario',
  'negociacao_aprovada',
  'negociacao_aprovada_avista',
  'confirmacao_pagamento',
  'daily_summary',
  'venda_feita',
  'admin_agendamento_equipe',
  'block_sched_on_overdue',
  ...REGUA_DO_LABORATORIO,
]);

/** Motivo da recusa da Central no laboratório (texto em LAB_RECUSA_DISPAROS). */
export type MotivoRecusaLab = 'escondido' | 'antecedencia' | 'aniversario' | 'template' | 'teste';

/** Recusa do liga/desliga no laboratório: null = aceito; 'escondido' = aviso que não existe nele. */
export function recusaDoToggleNoLaboratorio(which: string): MotivoRecusaLab | null {
  return TOGGLES_DO_LABORATORIO.has(which) ? null : 'escondido';
}

/** Textos de cobrança (GET/PUT /followup/cobranca-template/:stage) editáveis no laboratório. */
export const TEMPLATES_FIN_DO_LABORATORIO: ReadonlySet<string> = new Set<string>([
  'negociacao_aprovada',
  'negociacao_aprovada_avista',
  'confirmacao_pagamento',
  ...REGUA_DO_LABORATORIO,
]);

/** Ids do Testar da Central (POST /calendar/disparo/send-test) aceitos no laboratório. */
export const TESTES_DO_LABORATORIO: ReadonlySet<string> = new Set<string>([
  'confirmacao',
  'confirmacao_48h',
  'lembrete_1dia',
  'reagendamento',
  'aniversario',
  'aniversario_classica',
  'resumo_dentista',
  'negociacao_aprovada',
  'negociacao_aprovada_avista',
  'confirmacao_pagamento',
  ...REGUA_DO_LABORATORIO,
]);

/**
 * Texto padrão de um template de cobrança no laboratório: o orçamento aprovado (parcelado
 * e à vista), a confirmação de pagamento (texto neutro, o mesmo da clínica) e a régua
 * (por tipo de pagamento nos marcos; sem tipo, o de parcela). null para o que não é
 * editável no laboratório.
 */
export function padraoFinDoLaboratorio(stage: string, tipo?: CobrancaTipo): string | null {
  if (stage === 'negociacao_aprovada') return LAB_NEGOCIACAO.parcelado;
  if (stage === 'negociacao_aprovada_avista') return LAB_NEGOCIACAO.avista;
  if (stage === 'confirmacao_pagamento') return DEFAULT_CONFIRMACAO_PAGAMENTO;
  if (stage === 'boleto_intro') return LAB_REGUA.apresentacao;
  if (stage === 'boleto_delivery') return LAB_REGUA.entrega;
  if (isCobrancaStage(stage)) {
    return LAB_REGUA.marcos[stage].replace(/\{item\}/g, LAB_REGUA.palavras[tipo ?? 'parcelado']);
  }
  return null;
}
