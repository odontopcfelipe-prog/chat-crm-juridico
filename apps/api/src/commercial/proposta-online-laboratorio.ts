/**
 * Paridade clínica → laboratório — LINK DE ACEITE ON-LINE do orçamento de trabalho.
 *
 * A clínica manda o orçamento com um link de acesso; o laboratório passa a mandar o
 * seu: o PDF segue indo junto (orcamento-whatsapp-laboratorio.ts) e a legenda ganha o
 * link desta página. O cliente do laboratório abre, vê os serviços, o total e as
 * condições, e aceita escrevendo o nome.
 *
 * O link é um token aleatório guardado em PortalToken (a mesma tabela dos links da
 * clínica), com channel 'LAB_PROPOSTA:<id do orçamento>'. Não é consumido ao abrir
 * (o cliente pode voltar), vence em 30 dias a contar do último envio e só abre ESTE
 * orçamento: o token nunca troca por sessão do portal do cliente (o exchange recusa este
 * canal) e nada do resto do portal responde por ele.
 *
 * O que a página mostra é um select fechado: nome da conta, número, validade, serviços,
 * totais e condições. Nunca a ficha do caso (nome do paciente do dentista, cor, material),
 * documento, telefone nem anexos.
 *
 * Funções puras (sem provider Nest): o envio usa criarLinkDaProposta; a rota pública
 * usa verPropostaPublica / aceitarPropostaPublica.
 */
import { randomBytes } from 'crypto';
import { BadRequestException, NotFoundException, type Logger } from '@nestjs/common';
import { contaDoLabPodeEnviar, isLabTenant } from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { registrarAuditoria } from '../common/utils/audit-log.util';
import { numeroDoOrcamento } from './quote-pdf-laboratorio';
import { LAB_PROPOSTA_ONLINE } from './lab-proposta-online-textos';

export const PREFIXO_DO_CANAL = 'LAB_PROPOSTA:';
const VALIDADE_DO_LINK_DIAS = 30;

export type DadosDoAceite = { nome: string; ip?: string; userAgent?: string };

/** Endereço público do sistema (o mesmo dos e-mails do sistema). */
export function enderecoPublico(): string {
  return (process.env.PORTAL_PUBLIC_URL || process.env.PUBLIC_WEB_URL || 'https://sistema.institutoodontopassos.com.br').replace(/\/+$/, '');
}

/**
 * Link do orçamento (cria o token, ou reaproveita o que ainda vale: o reenvio mantém o
 * mesmo link e renova a validade). `quote` precisa de id e patient_id. A conta é a do
 * orçamento já validado por quem chama (findOne do QuotesService).
 */
export async function criarLinkDaProposta(
  prisma: PrismaService,
  tenantId: string,
  quote: { id: string; patient_id: string },
): Promise<string> {
  const canal = `${PREFIXO_DO_CANAL}${quote.id}`;
  const agora = new Date();
  const vence = new Date(agora.getTime() + VALIDADE_DO_LINK_DIAS * 86_400_000);
  const vigente = await prisma.portalToken.findFirst({
    where: { tenant_id: tenantId, patient_id: quote.patient_id, channel: canal, expires_at: { gt: agora } },
    orderBy: { created_at: 'desc' },
    select: { id: true, token: true },
  });
  let token = vigente?.token;
  if (vigente) {
    await prisma.portalToken.update({ where: { id: vigente.id }, data: { expires_at: vence } });
  } else {
    token = randomBytes(32).toString('base64url');
    await prisma.portalToken.create({
      data: { tenant_id: tenantId, patient_id: quote.patient_id, token, expires_at: vence, channel: canal },
    });
  }
  return `${enderecoPublico()}/proposta/${token}`;
}

type LinhaDoLink = { id: string; tenant_id: string; patient_id: string; expires_at: Date; channel: string };

/** Token → orçamento e conta. Qualquer falha vira o mesmo 404 (não revela o motivo). */
async function abrirLink(prisma: PrismaService, token: string, logger?: Logger): Promise<LinhaDoLink & { quoteId: string }> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new NotFoundException(LAB_PROPOSTA_ONLINE.linkInvalido);
  }
  const row = await prisma.portalToken.findUnique({
    where: { token },
    select: { id: true, tenant_id: true, patient_id: true, expires_at: true, channel: true },
  });
  if (!row || !row.channel.startsWith(PREFIXO_DO_CANAL) || row.expires_at < new Date()) {
    throw new NotFoundException(LAB_PROPOSTA_ONLINE.linkInvalido);
  }
  // Só conta de laboratório: o link nasce do envio do laboratório; a leitura é a mesma
  // lista em cache dos demais freios.
  if (!(await isLabTenant(prisma, row.tenant_id, (m) => logger?.warn(m)))) {
    throw new NotFoundException(LAB_PROPOSTA_ONLINE.linkInvalido);
  }
  // Conta suspensa ou congelada: o link responde como indisponível (nem mostra, nem aceita)
  // e volta a abrir quando a conta voltar a ficar ativa.
  if (!(await contaDoLabPodeEnviar(prisma, row.tenant_id))) {
    throw new NotFoundException(LAB_PROPOSTA_ONLINE.linkInvalido);
  }
  return { ...row, quoteId: row.channel.slice(PREFIXO_DO_CANAL.length) };
}

function hojeEmMaceio(): string {
  return new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
}

export type SituacaoDaProposta = 'ABERTO' | 'ACEITO' | 'VENCIDO' | 'ENCERRADO';

function situacao(q: { status: string; valid_until: Date | null; archived_at: Date | null }): SituacaoDaProposta {
  if (q.status === 'ACCEPTED') return 'ACEITO';
  if (q.archived_at || !['SENT'].includes(q.status)) {
    return q.status === 'EXPIRED' ? 'VENCIDO' : 'ENCERRADO';
  }
  if (q.valid_until && q.valid_until.toISOString().slice(0, 10) < hojeEmMaceio()) return 'VENCIDO';
  return 'ABERTO';
}

const SELECT_DA_PROPOSTA = {
  id: true,
  patient_id: true,
  quote_number: true,
  status: true,
  created_at: true,
  valid_until: true,
  deleted_at: true,
  archived_at: true,
  subtotal: true,
  discount_percent: true,
  discount_value: true,
  total_value: true,
  payment_terms: true,
  notes: true,
  patient: { select: { name: true, tenant_id: true } },
  items: {
    orderBy: { order_index: 'asc' as const },
    select: {
      procedure_id: true,
      quantity: true,
      unit_price: true,
      total_price: true,
      tooth_fdi: true,
      notes: true,
      procedure: { select: { name: true } },
    },
  },
} as const;

async function carregar(prisma: PrismaService, link: LinhaDoLink & { quoteId: string }) {
  // O orçamento tem de ser da MESMA conta do link e do mesmo cliente que o gerou.
  const quote = await prisma.quote.findFirst({
    where: { id: link.quoteId, patient_id: link.patient_id, patient: { tenant_id: link.tenant_id } },
    select: SELECT_DA_PROPOSTA,
  });
  // Apagado ou recusado (o recusado inclui o revisado): link indisponível, sem valores.
  if (!quote || quote.deleted_at || quote.status === 'REJECTED') throw new NotFoundException(LAB_PROPOSTA_ONLINE.linkInvalido);
  return quote;
}

const assinaturaDosServicos = (itens: Array<{ procedure_id: string; tooth_fdi: string | null; quantity: number }>) =>
  itens.map((i) => `${i.procedure_id}|${i.tooth_fdi ?? ''}|${i.quantity}`).sort().join(';');

/**
 * Outra opção deste orçamento já foi aceita? A opção (duplicateAsOption) é uma cópia sem
 * vínculo gravado, então vale o que ela é: mesmo cliente e mesmos serviços (serviço,
 * elemento e quantidade), aceita depois que este orçamento já existia. Um pedido repetido
 * mais tarde não trava, e fichas de caso com referências diferentes são trabalhos diferentes.
 * A leitura do caso fica aqui: nada dele vai para a página.
 */
async function outraOpcaoAceita(
  prisma: PrismaService,
  quote: { id: string; patient_id: string; created_at: Date; items: Array<{ procedure_id: string; tooth_fdi: string | null; quantity: number }> },
): Promise<boolean> {
  const aceitos = await prisma.quote.findMany({
    where: { patient_id: quote.patient_id, id: { not: quote.id }, status: 'ACCEPTED', deleted_at: null, accepted_at: { gte: quote.created_at } },
    select: { id: true, items: { select: { procedure_id: true, tooth_fdi: true, quantity: true } } },
  });
  const assinatura = assinaturaDosServicos(quote.items);
  const opcoes = aceitos.filter((q) => assinaturaDosServicos(q.items) === assinatura);
  if (!opcoes.length) return false;
  const casos = await prisma.quoteLabCase.findMany({
    where: { quote_id: { in: [quote.id, ...opcoes.map((q) => q.id)] } },
    select: { quote_id: true, patient_ref: true },
  });
  const referencia = new Map(casos.map((c) => [c.quote_id, c.patient_ref?.trim().toLowerCase() || null]));
  const deste = referencia.get(quote.id);
  return opcoes.some((q) => {
    const dela = referencia.get(q.id);
    return !deste || !dela || deste === dela;
  });
}

const num = (v: unknown) => Number(v ?? 0);

/** Dados da página pública. Conta uma visualização (melhor esforço). */
export async function verPropostaPublica(prisma: PrismaService, token: string, logger?: Logger) {
  const link = await abrirLink(prisma, token, logger);
  const quote = await carregar(prisma, link);
  const conta = await prisma.tenant.findUnique({ where: { id: link.tenant_id }, select: { name: true, logo_url: true } });

  await prisma.quote
    .update({ where: { id: quote.id }, data: { portal_view_count: { increment: 1 }, portal_last_viewed_at: new Date() } })
    .catch(() => undefined);

  const lida = situacao(quote);
  const estado = lida === 'ABERTO' && (await outraOpcaoAceita(prisma, quote)) ? 'ENCERRADO' : lida;
  return {
    laboratorio: {
      nome: conta?.name?.trim() || LAB_PROPOSTA_ONLINE.nomeDoLaboratorioPadrao,
      logo: typeof conta?.logo_url === 'string' && conta.logo_url.startsWith('data:image/') ? conta.logo_url : null,
    },
    cliente: quote.patient?.name?.trim() || null,
    numero: numeroDoOrcamento(quote),
    situacao: estado,
    pode_aceitar: estado === 'ABERTO',
    valido_ate: quote.valid_until ? quote.valid_until.toISOString().slice(0, 10) : null,
    servicos: quote.items.map((i) => ({
      nome: i.procedure?.name ?? null,
      elemento: i.tooth_fdi ?? null,
      quantidade: i.quantity,
      unitario: num(i.unit_price),
      total: num(i.total_price),
      observacao: i.notes ?? null,
    })),
    subtotal: num(quote.subtotal),
    desconto_percentual: num(quote.discount_percent),
    desconto: num(quote.discount_value),
    total: num(quote.total_value),
    condicoes: quote.payment_terms ?? null,
    observacoes: quote.notes ?? null,
  };
}

/**
 * Aceite do cliente. Faz o mesmo que o "Aceitar" da equipe (QuotesService.accept): o
 * orçamento vira aceito e o trabalho nasce em produção; nenhuma cobrança sai daqui (o
 * Financeiro valida e cobra como em qualquer outro aceite). Registra quem aceitou,
 * quando e de onde no histórico da conta.
 */
export async function aceitarPropostaPublica(
  deps: {
    prisma: PrismaService;
    aceitar: (quoteId: string, tenantId: string) => Promise<unknown>;
    logger: Logger;
  },
  token: string,
  dados: DadosDoAceite,
) {
  const { prisma, aceitar, logger } = deps;
  const nome = String(dados?.nome ?? '').replace(/\s+/g, ' ').trim();
  if (nome.length < 3 || nome.length > 120) throw new BadRequestException(LAB_PROPOSTA_ONLINE.nomeObrigatorio);

  const link = await abrirLink(prisma, token, logger);
  const quote = await carregar(prisma, link);
  const estado = situacao(quote);
  if (estado === 'ACEITO') throw new BadRequestException(LAB_PROPOSTA_ONLINE.jaAceita);
  if (estado === 'VENCIDO') throw new BadRequestException(LAB_PROPOSTA_ONLINE.vencida);
  if (estado !== 'ABERTO') throw new BadRequestException(LAB_PROPOSTA_ONLINE.encerrada);
  if (await outraOpcaoAceita(prisma, quote)) throw new BadRequestException(LAB_PROPOSTA_ONLINE.outraOpcaoAceita);

  try {
    await aceitar(quote.id, link.tenant_id);
  } catch (e: any) {
    logger.warn(`[LAB-PROPOSTA] aceite do orçamento ${quote.id} falhou: ${e?.message ?? e}`);
    throw new BadRequestException(LAB_PROPOSTA_ONLINE.erroAceite);
  }

  await registrarAuditoria(
    prisma,
    {
      tenantId: link.tenant_id,
      actorUserId: null,
      entity: 'QUOTE',
      entityId: quote.id,
      action: 'ACEITE_ONLINE',
      meta: {
        descricao: LAB_PROPOSTA_ONLINE.descricaoDoAceite(numeroDoOrcamento(quote)),
        nome,
        ip: dados.ip ? String(dados.ip).slice(0, 64) : null,
        agente: dados.userAgent ? String(dados.userAgent).slice(0, 160) : null,
      },
    },
    logger,
  );
  return { ok: true as const, situacao: 'ACEITO' as const };
}
