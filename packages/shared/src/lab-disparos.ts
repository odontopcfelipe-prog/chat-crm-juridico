/**
 * F7 do laboratório — o que a Central de Disparos do laboratório mostra e aceita.
 * Usado pelo web (filtro dos cards) e pela API (recusa no servidor). Os textos ficam
 * em lab-disparos-textos.ts.
 *
 * Negação por padrão: card ou liga/desliga que não está aqui não existe no
 * laboratório. A régua de cobrança aparece com o liga/desliga travado (o servidor só
 * aceita desligar) até o envio em fila por chip chegar.
 *
 * Módulo puro (sem Prisma, sem Nest).
 */
import { DEFAULT_CONFIRMACAO_PAGAMENTO } from './cobranca';
import { LAB_NEGOCIACAO } from './lab-disparos-textos';

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

/** Cards da régua de cobrança: aparecem, sem editor, e só aceitam desligar. */
export const REGUA_DO_LABORATORIO: ReadonlySet<string> = new Set<string>([
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
]);

/** Valores de `which` da régua: no laboratório só aceitam enabled=false. */
export const TOGGLES_DA_REGUA_NO_LABORATORIO: ReadonlySet<string> = new Set<string>([
  'boleto_1d_antes',
  'boleto_no_dia',
  'boleto_atraso_1d',
  'boleto_atraso_2d',
  'boleto_atraso_3d',
  'boleto_atraso_15d',
  'boleto_atraso_30d',
  'boleto_atrasado',
  'boleto_intro',
  'boleto_delivery',
]);

/** Motivo da recusa da Central no laboratório (texto em LAB_RECUSA_DISPAROS). */
export type MotivoRecusaLab = 'escondido' | 'regua' | 'antecedencia' | 'aniversario' | 'template' | 'teste';

/**
 * Recusa do liga/desliga no laboratório: null = aceito; 'regua' = régua sendo
 * ligada; 'escondido' = o resto (aviso que não existe no laboratório).
 */
export function recusaDoToggleNoLaboratorio(which: string, enabled: boolean): MotivoRecusaLab | null {
  if (TOGGLES_DA_REGUA_NO_LABORATORIO.has(which)) return enabled ? 'regua' : null;
  if (TOGGLES_DO_LABORATORIO.has(which)) return null;
  return 'escondido';
}

/** Textos de cobrança (GET/PUT /followup/cobranca-template/:stage) editáveis no laboratório. */
export const TEMPLATES_FIN_DO_LABORATORIO: ReadonlySet<string> = new Set<string>([
  'negociacao_aprovada',
  'negociacao_aprovada_avista',
  'confirmacao_pagamento',
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
]);

/**
 * Texto padrão de um template de cobrança no laboratório: o orçamento aprovado do
 * laboratório (parcelado e à vista) e a confirmação de pagamento (texto neutro, o
 * mesmo da clínica). null para o que não é editável no laboratório.
 */
export function padraoFinDoLaboratorio(stage: string): string | null {
  if (stage === 'negociacao_aprovada') return LAB_NEGOCIACAO.parcelado;
  if (stage === 'negociacao_aprovada_avista') return LAB_NEGOCIACAO.avista;
  if (stage === 'confirmacao_pagamento') return DEFAULT_CONFIRMACAO_PAGAMENTO;
  return null;
}
