/**
 * Aviso AGRUPADO da régua de cobrança — paciente com 2+ cobranças em aberto no
 * mesmo disparo recebe UM aviso (total), não N (anti-spam/anti-ban).
 *
 * Segue o MESMO padrão do aviso de boleto único (Onda 18.x):
 *   - boleto vai como PDF ANEXO (sem link — "link gera desconfiança");
 *   - PIX copia-e-cola vai em mensagem PRÓPRIA, só o código (copia limpo);
 *   - link só como ÚLTIMO recurso (cobrança sem PDF e sem PIX), pra nunca deixar o
 *     paciente sem como pagar.
 * Antes o agrupado tinha texto próprio com a lista de links e nunca buscava o PDF
 * no Asaas — saía "Acesse pelos links abaixo" fora do padrão.
 */

/** Uma cobrança dentro do aviso agrupado. */
export interface GroupMember {
  chargeId: string;
  externalId?: string;
  gateway?: string;
  amount: number;
  dueDate: Date;
  /** invoice/boleto/pix — último recurso, só quando não há PDF nem PIX. */
  link: string;
  /** PDF do boleto → vai como anexo. */
  pdfUrl?: string;
  /** PIX copia-e-cola → vai em mensagem separada. */
  codigo?: string;
}

/** Tetos por aviso (anti-ban): PDFs anexos e códigos PIX em mensagens separadas.
 *  O que passar disso cai no link. */
export const GROUP_MAX_PDFS = 6;
export const GROUP_MAX_PIX_MSGS = 5;

/** Chave da cobrança: a mesma cobrança duplicada no banco (mesmo id do Asaas)
 *  não pode sair 2× nem somar 2× no total. */
export const memberKey = (m: GroupMember) => m.externalId || m.chargeId;

export interface GroupPlan {
  /** Vão como PDF anexo (o 1º leva a legenda). */
  pdfs: GroupMember[];
  /** Código PIX em mensagem própria, nesta ordem. */
  pix: GroupMember[];
  /** Sem PDF nem PIX (ou além do teto) → link no texto. */
  links: GroupMember[];
}

/** Decide como cada cobrança do grupo vai: PDF > PIX > link. */
export function planGroup(members: GroupMember[]): GroupPlan {
  const pdfs = members.filter((m) => m.pdfUrl).slice(0, GROUP_MAX_PDFS);
  const resto = members.filter((m) => !pdfs.includes(m));
  const pix = resto.filter((m) => m.codigo).slice(0, GROUP_MAX_PIX_MSGS);
  const links = resto.filter((m) => !pix.includes(m) && m.link);
  return { pdfs, pix, links };
}

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const ddmm = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** Texto da mensagem 1 (legenda do 1º PDF, ou texto puro se não houver PDF). */
export function buildGroupMessage(
  firstName: string,
  clinica: string,
  total: number,
  plan: GroupPlan,
): string {
  const n = plan.pdfs.length + plan.pix.length + plan.links.length;
  // "boletos" só quando todas são boleto com PDF; com PIX/link no meio, "cobranças".
  const oque = plan.pix.length || plan.links.length ? 'cobranças' : 'boletos';
  const partes: string[] = [
    `Olá ${firstName}, você tem ${n} ${oque} em aberto na ${clinica}, no total de *${brl(total)}*.`,
  ];
  if (plan.pdfs.length) {
    partes.push(plan.pdfs.length === 1 ? '📎 Segue o boleto em anexo.' : '📎 Seguem os boletos em anexo.');
  }
  if (plan.pix.length) {
    // Os códigos saem DEPOIS de todos os PDFs — com anexo, "próxima mensagem" mentiria.
    const depois = plan.pdfs.length ? (plan.pdfs.length === 1 ? ' logo depois do boleto' : ' logo depois dos boletos') : '';
    const head =
      plan.pix.length === 1
        ? (depois ? `O código *PIX* da outra vai${depois} 👇` : 'O código *PIX* pra pagar vai na *próxima mensagem* 👇')
        : (depois
            ? `Os códigos *PIX* das demais vão${depois}, nesta ordem 👇`
            : 'Os códigos *PIX* vão nas *próximas mensagens*, nesta ordem 👇');
    const lista = plan.pix.map((m) => `• ${brl(m.amount)} — venc. ${ddmm(m.dueDate)}`).join('\n');
    partes.push(`${head}\n${lista}`);
  }
  if (plan.links.length) {
    const resto = plan.pdfs.length || plan.pix.length ? (plan.links.length === 1 ? ' a outra' : ' as demais') : '';
    // Sem invoice/boleto o "link" é o texto "Pix copia e cola: …" — aí não é "acesse".
    const soUrl = plan.links.every((m) => /^https?:\/\//.test(m.link));
    partes.push(`Pra pagar${resto}${soUrl ? ', acesse' : ''}:\n${plan.links.map((m) => m.link).join('\n')}`);
  }
  partes.push('Se já pagou algum, é só desconsiderar. Qualquer dúvida, estamos à disposição.');
  return partes.join('\n\n');
}
