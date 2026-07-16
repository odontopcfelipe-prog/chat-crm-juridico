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

// NEGOCIAÇÃO APROVADA — disparo no FECHAMENTO da venda (D+0): confirma ao paciente
// as condições que ele fechou (entrada + parcelas + total). Substitui a apresentação
// (D+1). Placeholders: {nome} {condicoes} {clinica} — e os avulsos {entrada}
// {parcelas} {valor_parcela} {total} {forma} pra quem quiser montar o texto na mão.
// {condicoes} vem pronto do backend (bloco com entrada/parcelas/total ou só total).
export const DEFAULT_NEGOCIACAO_APROVADA =
  'Olá, {nome}! 🎉 Seu tratamento foi *aprovado*.\n\n' +
  '{condicoes}\n\n' +
  'Já já o setor financeiro te envia os boletos por aqui. Qualquer dúvida, é só chamar! 💙';

/** Ids de template financeiro editáveis: os 5 boletos + confirmação + apresentação + negociação. */
export function isFinTemplateId(s: string): boolean {
  return (
    isCobrancaStage(s) ||
    s === 'confirmacao_pagamento' ||
    s === 'boleto_intro' ||
    s === 'negociacao_aprovada'
  );
}

/** Texto padrão de um template financeiro editável. */
export function defaultFinTemplate(id: string): string {
  if (id === 'confirmacao_pagamento') return DEFAULT_CONFIRMACAO_PAGAMENTO;
  if (id === 'boleto_intro') return DEFAULT_BOLETO_INTRO;
  if (id === 'negociacao_aprovada') return DEFAULT_NEGOCIACAO_APROVADA;
  return (DEFAULT_COBRANCA_TEMPLATES as Record<string, string>)[id] || '';
}

/** Chave da GlobalSetting do template daquele estágio (api grava, worker lê). */
export function cobrancaTemplateKey(stage: string, tenantId?: string | null): string {
  const base = `COBRANCA_TEMPLATE_${stage.toUpperCase()}`;
  return tenantId ? `${base}_${tenantId}` : base;
}
