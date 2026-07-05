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

/** Chave da GlobalSetting do template daquele estágio (api grava, worker lê). */
export function cobrancaTemplateKey(stage: string, tenantId?: string | null): string {
  const base = `COBRANCA_TEMPLATE_${stage.toUpperCase()}`;
  return tenantId ? `${base}_${tenantId}` : base;
}
