// Onda 18.17 — Templates de cobrança financeira (chip FINANCEIRO). Fonte ÚNICA
// compartilhada: a API edita/serve (editor da Central de Disparos) e o worker lê
// na hora de disparar. Sem duplicar texto entre os dois — assim editar na tela
// muda o que o cron manda de verdade. Placeholders: {nome} {valor} {data} {link}.

export type CobrancaStage =
  | 'boleto_1d_antes'
  | 'boleto_no_dia'
  | 'boleto_atraso_1d'
  | 'boleto_atraso_15d'
  | 'boleto_atraso_30d';

export const COBRANCA_STAGES: CobrancaStage[] = [
  'boleto_1d_antes',
  'boleto_no_dia',
  'boleto_atraso_1d',
  'boleto_atraso_15d',
  'boleto_atraso_30d',
];

/** Rascunhos aprovados pelo cliente (gentil → firme). {nome} {valor} {data} {link}. */
export const DEFAULT_COBRANCA_TEMPLATES: Record<CobrancaStage, string> = {
  boleto_1d_antes:
    'Oi {nome}! 😊 Passando pra lembrar que sua parcela de *{valor}* vence *amanhã ({data})*.\n\n' +
    'Segue o boleto/pix pra facilitar: {link}\n\nQualquer dúvida, é só chamar aqui!',
  boleto_no_dia:
    'Oi {nome}! 📅 Sua parcela de *{valor}* vence *hoje ({data})*.\n\n' +
    'Pra não perder o prazo, segue o boleto/pix: {link}\n\nSe já pagou, pode desconsiderar 🙏',
  boleto_atraso_1d:
    'Oi {nome}, tudo bem? Notamos que sua parcela de *{valor}* venceu ontem ({data}) e ainda consta em aberto — ' +
    'deve ser só um esquecimento 😉\n\nSegue o boleto atualizado: {link}\n\nSe já pagou, é só desconsiderar!',
  boleto_atraso_15d:
    'Oi {nome}, sua parcela de *{valor}* está em aberto há *15 dias* (venceu em {data}).\n\n' +
    'Pra regularizar e evitar juros maiores, segue o boleto atualizado: {link}\n\n' +
    'Precisa de ajuda ou quer renegociar? É só chamar a gente aqui.',
  boleto_atraso_30d:
    'Oi {nome}, sua parcela de *{valor}* está com *30 dias* de atraso (venceu em {data}).\n\n' +
    'Pedimos a gentileza de regularizar pra manter seu tratamento em dia: {link}\n\n' +
    'Se estiver com dificuldade, fale com a gente — podemos encontrar uma solução juntos.',
};

export function isCobrancaStage(s: string): s is CobrancaStage {
  return (COBRANCA_STAGES as string[]).includes(s);
}

// ─── Texto do lembrete POR TIPO DE PAGAMENTO ────────────────────────────────
// O mesmo estágio fala diferente conforme a cobrança: PIX à vista NÃO é "parcela"
// nem "boleto"; boleto 1× não é "parcela". A clínica edita cada tipo separado na
// Central; a cron escolhe pela cobrança real (billing_type + se é parcela).

export type CobrancaTipo = 'pix' | 'boleto' | 'parcelado';
export const COBRANCA_TIPOS: CobrancaTipo[] = ['pix', 'boleto', 'parcelado'];
export function isCobrancaTipo(s: string): s is CobrancaTipo {
  return (COBRANCA_TIPOS as string[]).includes(s);
}

/** Rótulo do tipo pra UI. */
export const COBRANCA_TIPO_LABEL: Record<CobrancaTipo, string> = {
  pix: 'PIX à vista',
  boleto: 'Boleto à vista',
  parcelado: 'Parcelado',
};

/** Palavras que trocam por tipo: {item} = o que vence; {meio} = como pagar.
 *  'parcelado' agrupa boleto E pix parcelados (Asaas parcela nos dois), então o
 *  {meio} fica NEUTRO ("o link de pagamento") pra não chamar um PIX de "boleto". */
const COBRANCA_TIPO_WORDS: Record<CobrancaTipo, { item: string; meio: string }> = {
  pix: { item: 'seu pagamento', meio: 'o PIX' },
  boleto: { item: 'seu boleto', meio: 'o boleto' },
  parcelado: { item: 'sua parcela', meio: 'o link de pagamento' },
};

/** Base ÚNICA de cada estágio com {item}/{meio} — os 3 defaults por tipo saem
 *  daqui preenchendo as palavras (DRY). {item} nunca abre frase (evita maiúscula). */
const COBRANCA_STAGE_BASE: Record<CobrancaStage, string> = {
  boleto_1d_antes:
    'Oi {nome}! 😊 Passando pra lembrar que {item} de *{valor}* vence *amanhã ({data})*.\n\n' +
    'Segue {meio} pra facilitar: {link}\n\nQualquer dúvida, é só chamar aqui!',
  boleto_no_dia:
    'Oi {nome}! 📅 Hoje ({data}) vence {item} de *{valor}*.\n\n' +
    'Pra não perder o prazo, segue {meio}: {link}\n\nSe já pagou, pode desconsiderar 🙏',
  boleto_atraso_1d:
    'Oi {nome}, tudo bem? Notamos que {item} de *{valor}* venceu ontem ({data}) e ainda consta em aberto — ' +
    'deve ser só um esquecimento 😉\n\nSegue {meio} atualizado: {link}\n\nSe já pagou, é só desconsiderar!',
  boleto_atraso_15d:
    'Oi {nome}, {item} de *{valor}* está em aberto há *15 dias* (venceu em {data}).\n\n' +
    'Pra regularizar e evitar juros maiores, segue {meio} atualizado: {link}\n\n' +
    'Precisa de ajuda ou quer renegociar? É só chamar a gente aqui.',
  boleto_atraso_30d:
    'Oi {nome}, {item} de *{valor}* está com *30 dias* de atraso (venceu em {data}).\n\n' +
    'Pedimos a gentileza de regularizar pra manter seu tratamento em dia: {link}\n\n' +
    'Se estiver com dificuldade, fale com a gente — podemos encontrar uma solução juntos.',
};

/** Texto padrão do estágio PARA UM TIPO (preenche {item}/{meio} da base). */
export function defaultCobrancaTemplate(stage: string, tipo: CobrancaTipo): string {
  const base = COBRANCA_STAGE_BASE[stage as CobrancaStage];
  if (!base) return (DEFAULT_COBRANCA_TEMPLATES as Record<string, string>)[stage] || '';
  const w = COBRANCA_TIPO_WORDS[tipo] ?? COBRANCA_TIPO_WORDS.parcelado;
  return base.replace(/\{item\}/g, w.item).replace(/\{meio\}/g, w.meio);
}

/**
 * Tag INTERNA que a descrição da cobrança carrega pra ligar cobrança↔plano
 * (`... [plan:{uuid}]`). É load-bearing NO BANCO: dezenas de lugares casam por
 * `description contains plan:{id}`, incluindo o check de idempotência que impede
 * cobrança duplicada. NUNCA remover da coluna — só do texto que o PACIENTE lê.
 */
export const PLAN_TAG_RE = /\s*\[plan:[^\]]+\]/g;

/** Tira as tags internas de um texto que vai pro paciente (o UUID vazava na msg). */
export function stripInternalTags(s?: string | null): string {
  return (s || '').replace(PLAN_TAG_RE, '').trim();
}

// Onda 18.28 — confirmação de pagamento (por EVENTO, webhook do Asaas). NÃO entra
// em COBRANCA_STAGES (o cron não a agenda), mas é um template EDITÁVEL igual aos
// boletos. {descricao} já vem com parênteses (ou vazio) pronto do backend.
export const DEFAULT_CONFIRMACAO_PAGAMENTO =
  '✅ *Pagamento Confirmado!*\n\n' +
  'Olá, {nome}!\n\n' +
  'Confirmamos o recebimento do pagamento no valor de *{valor}*{descricao}.\n\n' +
  'Agradecemos pela pontualidade! Qualquer dúvida, estamos à disposição.';

// Parte 1 — APRESENTAÇÃO do setor financeiro no dia SEGUINTE ao fechamento da
// venda: o Financeiro se apresenta e avisa que amanhã manda todos os boletos (em
// PDF). NÃO entra em COBRANCA_STAGES (o cron não a agenda por vencimento; dispara
// por venda fechada ontem). Editável igual aos boletos. Placeholders: {nome} {clinica}.
export const DEFAULT_BOLETO_INTRO =
  'Olá, {nome}! 😊\n\n' +
  'Aqui é o setor financeiro da {clinica}. Seja muito bem-vindo(a)! A partir de agora é por aqui ' +
  'que a gente cuida de tudo sobre os seus pagamentos.\n\n' +
  'Amanhã vou te enviar todos os seus boletos em PDF, certinho pra você se organizar. 📄\n\n' +
  'Qualquer dúvida, é só me chamar por aqui. Estou à disposição! 💙';

// Parte 2 — ENVIO dos boletos (D+2): o texto de abertura que acompanha o carnê (1
// PDF com todas as parcelas). NÃO promete nada nem cita prazo — pode sair D+1 ou
// dias depois (a janela de entrega é larga). Placeholders: {nome} {clinica}.
export const DEFAULT_BOLETO_DELIVERY =
  'Olá, {nome}! 📄 Aqui estão os seus boletos, todos em PDF. ' +
  'Qualquer dúvida, é só me chamar por aqui! 💙';

// NEGOCIAÇÃO APROVADA — disparo no FECHAMENTO da venda (D+0): confirma ao paciente
// O QUE foi vendido + as condições, e — quando é PIX — já manda o código PIX pra
// pagar na hora. Substitui a apresentação (D+1). Placeholders:
//   {nome} {clinica} — básicos
//   {itens} — lista do que foi vendido (procedimentos), pronta do backend
//   {condicoes} — bloco entrada/parcelas/total (ou só total); {condicoes_sem_total} sem o total
//   {codigo_pix} — bloco "Pague no PIX (copia e cola)" — SÓ quando a venda é PIX e a
//                  conta Asaas está conectada; vazio nos outros tipos (boleto/cartão)
//   avulsos: {entrada} {parcelas} {valor_parcela} {total} {forma}
export const DEFAULT_NEGOCIACAO_APROVADA =
  'Olá, {nome}! 🎉 Seu tratamento foi *aprovado*.\n\n' +
  '{itens}\n\n' +
  '{condicoes}{codigo_pix}\n\n' +
  'Qualquer dúvida, é só chamar por aqui! 💙';

/**
 * Monta o bloco de condições ({condicoes} = entrada + parcelas + total; {condicoes_sem_total}
 * = o mesmo sem a linha do total). Fonte ÚNICA usada pela negociação aprovada (valores do
 * orçamento fechado) e pela entrega dos boletos (valores derivados das cobranças) — pra os
 * dois NUNCA divergirem de formato. `formaLabel` só aparece no caso à vista (a entrega não passa).
 */
export function buildCondicoesBlock(t: {
  entrada?: number;
  parcelas?: number;
  valorParcela?: number;
  total: number;
  formaLabel?: string;
}): { condicoes: string; condicoesSemTotal: string } {
  const brl = (v?: number) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if ((t.entrada && t.entrada > 0) || (t.parcelas && t.parcelas > 1)) {
    const linhas: string[] = [];
    if (t.entrada && t.entrada > 0) linhas.push(`• Entrada: R$ ${brl(t.entrada)}`);
    // Sem `> 1` de propósito: espelha a negociação (entrada + 1 parcela mostra "1x de").
    // A entrega passa parcelas 0 ou >1 (nunca 1), então não gera "1x de" indevido lá.
    if (t.parcelas && t.valorParcela) linhas.push(`• ${t.parcelas}x de R$ ${brl(t.valorParcela)}`);
    return {
      condicoesSemTotal: linhas.join('\n'),
      condicoes: [...linhas, `• Total: R$ ${brl(t.total)}`].join('\n'),
    };
  }
  return {
    condicoes: `• Total: R$ ${brl(t.total)}${t.formaLabel ? ` (${t.formaLabel})` : ''}`,
    condicoesSemTotal: t.formaLabel ? `• Pagamento à vista (${t.formaLabel})` : '',
  };
}

/** Ids de template financeiro editáveis: os 5 boletos + confirmação + apresentação + negociação. */
export function isFinTemplateId(s: string): boolean {
  return (
    isCobrancaStage(s) ||
    s === 'confirmacao_pagamento' ||
    s === 'boleto_intro' ||
    s === 'boleto_delivery' ||
    s === 'negociacao_aprovada'
  );
}

/** Texto padrão de um template financeiro editável. Pros 5 estágios de cobrança
 *  o default é POR TIPO (pix/boleto/parcelado); sem tipo, cai no 'parcelado'. */
export function defaultFinTemplate(id: string, tipo?: CobrancaTipo): string {
  if (id === 'confirmacao_pagamento') return DEFAULT_CONFIRMACAO_PAGAMENTO;
  if (id === 'boleto_intro') return DEFAULT_BOLETO_INTRO;
  if (id === 'boleto_delivery') return DEFAULT_BOLETO_DELIVERY;
  if (id === 'negociacao_aprovada') return DEFAULT_NEGOCIACAO_APROVADA;
  if (isCobrancaStage(id)) return defaultCobrancaTemplate(id, tipo ?? 'parcelado');
  return (DEFAULT_COBRANCA_TEMPLATES as Record<string, string>)[id] || '';
}

/** Chave da GlobalSetting do template (api grava, worker lê). `tipo` (só pros 5
 *  estágios) grava uma variante separada por tipo de pagamento; sem tipo é a chave
 *  LEGADA (texto único) — mantida pra não quebrar quem já editou antes do split. */
export function cobrancaTemplateKey(stage: string, tenantId?: string | null, tipo?: CobrancaTipo): string {
  const base = `COBRANCA_TEMPLATE_${stage.toUpperCase()}${tipo ? `_${tipo.toUpperCase()}` : ''}`;
  return tenantId ? `${base}_${tenantId}` : base;
}
