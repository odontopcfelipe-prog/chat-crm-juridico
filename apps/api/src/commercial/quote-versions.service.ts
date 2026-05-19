/**
 * QuoteVersionsService — versioning + renegociacao de orcamentos (Fase 24 Onda 3b).
 *
 * Workflow tipico de renegociacao:
 *  1. Operador envia v1 (R$ 8.000)
 *  2. Paciente acha caro
 *  3. Operador clica "Renegociar":
 *     - Snapshot final do v1 (status=REJECTED + trigger=RENEGOTIATE)
 *     - Quote atual marcado REJECTED com reason="Renegociado para nova versao"
 *     - Novo Quote DRAFT criado com mesmos items (sem cupom — operador re-aplica)
 *     - new_quote.renegotiated_from_id = old_quote.id
 *  4. Operador edita preco/items, envia v2 (R$ 6.500)
 *  5. Toda a cadeia fica visivel: v2 -> renegociado de v1
 *
 * Snapshot automatico em momentos chave:
 *  - SEND (DRAFT -> SENT)
 *  - ACCEPT (SENT -> ACCEPTED)
 *  - REJECT (SENT -> REJECTED)
 *  - RENEGOTIATE (chamado explicitamente)
 *
 * Snapshot eh JSON imutavel — preserva preco, items com nome do procedimento
 * no momento, cupom, condicoes, validade. Mesmo se procedure for renomeada
 * ou removida depois, o historico fica intacto.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class QuoteVersionsService {
  private readonly logger = new Logger(QuoteVersionsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Captura snapshot do estado atual do quote. Usado pelos hooks dos
   * metodos send/accept/reject de QuotesService — chamar ANTES de mudar
   * o status pra preservar o estado "no momento daquele evento".
   */
  async createSnapshot(
    quoteId: string,
    actorUserId: string,
    trigger: 'SEND' | 'ACCEPT' | 'REJECT' | 'RENEGOTIATE' | 'MANUAL',
    changeNote?: string,
  ) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        items: {
          orderBy: { order_index: 'asc' },
          include: {
            procedure: { select: { id: true, name: true, code_tuss: true } },
          },
        },
        coupon: {
          select: {
            id: true,
            code: true,
            discount_type: true,
            discount_amount: true,
          },
        },
      },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');

    // Numero da nova versao (max + 1)
    const last = await (this.prisma as any).quoteVersion.findFirst({
      where: { quote_id: quoteId },
      orderBy: { version_number: 'desc' },
      select: { version_number: true },
    });
    const versionNumber = (last?.version_number || 0) + 1;

    // Snapshot completo — preserva tudo que importa pra reconstrucao depois
    const snapshot = {
      status: quote.status,
      subtotal: Number(quote.subtotal),
      discount_percent: Number(quote.discount_percent),
      discount_value: Number(quote.discount_value),
      total_value: Number(quote.total_value),
      payment_terms: quote.payment_terms,
      notes: quote.notes,
      valid_until: quote.valid_until,
      sent_at: quote.sent_at,
      accepted_at: quote.accepted_at,
      rejected_at: quote.rejected_at,
      rejection_reason: quote.rejection_reason,
      coupon: quote.coupon
        ? {
            id: quote.coupon.id,
            code: quote.coupon.code,
            discount_type: quote.coupon.discount_type,
            discount_amount: Number(quote.coupon.discount_amount),
          }
        : null,
      items: quote.items.map((i) => ({
        id: i.id,
        procedure_id: i.procedure_id,
        procedure_name: i.procedure?.name || null, // preserva nome no momento
        procedure_code_tuss: i.procedure?.code_tuss || null,
        tooth_fdi: i.tooth_fdi,
        quantity: i.quantity,
        unit_price: Number(i.unit_price),
        total_price: Number(i.total_price),
        notes: i.notes,
        order_index: i.order_index,
      })),
    };

    const version = await (this.prisma as any).quoteVersion.create({
      data: {
        quote_id: quoteId,
        version_number: versionNumber,
        status: quote.status,
        snapshot,
        total_value: quote.total_value,
        trigger,
        change_note: changeNote || null,
        created_by_id: actorUserId,
      },
    });

    this.logger.log(
      `[VERSION] Snapshot v${versionNumber} (${trigger}) criado pra quote ${quoteId}`,
    );
    return version;
  }

  /** Lista versoes (metadata, sem snapshot completo) — pra timeline na UI */
  async list(quoteId: string, tenantId: string) {
    await this.assertQuoteBelongsToTenant(quoteId, tenantId);
    return (this.prisma as any).quoteVersion.findMany({
      where: { quote_id: quoteId },
      orderBy: { version_number: 'desc' }, // mais recente primeiro
      select: {
        id: true,
        version_number: true,
        status: true,
        total_value: true,
        trigger: true,
        change_note: true,
        created_at: true,
        created_by: { select: { id: true, name: true } },
      },
    });
  }

  /** Detalhe de uma versao com snapshot completo (pra modal de comparacao) */
  async findOne(versionId: string, tenantId: string) {
    const version = await (this.prisma as any).quoteVersion.findUnique({
      where: { id: versionId },
      include: {
        quote: { include: { patient: { select: { tenant_id: true } } } },
        created_by: { select: { id: true, name: true } },
      },
    });
    if (!version) throw new NotFoundException('Versao nao encontrada');
    if (version.quote.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
    return version;
  }

  /**
   * Renegociar: cria duplicata DRAFT do orcamento atual e marca o atual
   * como REJECTED. Operador edita o novo (preco, items, etc), envia v2.
   *
   * Cupons NAO sao copiados (operador escolhe se aplica novamente — comum
   * trocar cupom em renegociacao).
   * Anexos TAMBEM nao sao copiados — recepcao decide o que reaproveitar
   * (cada upload eh fisico no storage).
   */
  async renegotiate(
    quoteId: string,
    tenantId: string,
    actorUserId: string,
    note?: string,
  ) {
    const original = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        patient: { select: { tenant_id: true } },
        items: { orderBy: { order_index: 'asc' } },
      },
    });
    if (!original) throw new NotFoundException('Orcamento nao encontrado');
    if (original.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
    if (!['SENT', 'REJECTED', 'EXPIRED'].includes(original.status)) {
      throw new BadRequestException(
        `Renegociacao so eh possivel pra orcamentos SENT/REJECTED/EXPIRED. Status atual: ${original.status}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Snapshot final do original com trigger=RENEGOTIATE
      // (delegamos pra createSnapshot mas usamos o tx — replicamos a logica simplificada)
      const lastVersion = await (tx as any).quoteVersion.findFirst({
        where: { quote_id: quoteId },
        orderBy: { version_number: 'desc' },
        select: { version_number: true },
      });
      const versionNumber = (lastVersion?.version_number || 0) + 1;
      await (tx as any).quoteVersion.create({
        data: {
          quote_id: quoteId,
          version_number: versionNumber,
          status: original.status,
          snapshot: {
            status: original.status,
            subtotal: Number(original.subtotal),
            discount_percent: Number(original.discount_percent),
            discount_value: Number(original.discount_value),
            total_value: Number(original.total_value),
            payment_terms: original.payment_terms,
            notes: original.notes,
            valid_until: original.valid_until,
            // items simplified — preservamos preco mas nao precisamos do nome do procedure aqui
            // (o snapshot principal eh em createSnapshot; aqui eh atalho transacional)
            items: original.items.map((i: any) => ({
              procedure_id: i.procedure_id,
              tooth_fdi: i.tooth_fdi,
              quantity: i.quantity,
              unit_price: Number(i.unit_price),
              total_price: Number(i.total_price),
            })),
          },
          total_value: original.total_value,
          trigger: 'RENEGOTIATE',
          change_note: note || 'Renegociado',
          created_by_id: actorUserId,
        },
      });

      // 2. Marca original como REJECTED com motivo Renegociado (se ainda nao terminal)
      if (original.status === 'SENT') {
        await tx.quote.update({
          where: { id: quoteId },
          data: {
            status: 'REJECTED',
            rejected_at: new Date(),
            rejection_reason: note || 'Renegociado pelo operador',
          },
        });
      }

      // 3. Cria novo orcamento DRAFT com mesmos items.
      // Onda 14.19 — Renegociacao cria quote NOVO; sem setar quote_number ele
      // sai com 0 (default) e some o identificador (#NNN) nas 4 abas. MAX+1
      // dentro do tx — ve o estado atual da tx, evita conflito com este create.
      const lastForTenant = await tx.quote.findFirst({
        where: { patient: { tenant_id: tenantId } },
        orderBy: { quote_number: 'desc' },
        select: { quote_number: true },
      });
      const nextQuoteNumber = (lastForTenant?.quote_number || 0) + 1;
      const newQuote = await tx.quote.create({
        data: {
          patient_id: original.patient_id,
          created_by_user_id: actorUserId,
          status: 'DRAFT',
          quote_number: nextQuoteNumber,
          // valid_until NAO copia — usa default 30d via service.create() normalmente,
          // mas como criamos direto, definimos aqui
          valid_until: (() => {
            const d = new Date();
            d.setDate(d.getDate() + 30);
            return d;
          })(),
          payment_terms: original.payment_terms,
          notes: original.notes,
          renegotiated_from_id: original.id,
          // Recalcula totais (sem desconto/cupom — operador reaplica)
          subtotal: Number(original.subtotal),
          discount_percent: 0,
          discount_value: 0,
          total_value: Number(original.subtotal),
          items: {
            create: original.items.map((i: any, idx: number) => ({
              procedure_id: i.procedure_id,
              tooth_fdi: i.tooth_fdi,
              quantity: i.quantity,
              unit_price: i.unit_price,
              total_price: i.total_price,
              notes: i.notes,
              order_index: idx,
            })),
          },
        },
        include: {
          items: {
            include: { procedure: { select: { id: true, name: true } } },
          },
        },
      });

      this.logger.log(
        `[RENEGOTIATE] Quote ${quoteId} renegociado -> novo DRAFT ${newQuote.id}`,
      );
      return newQuote;
    });
  }

  /**
   * Onda 3.4 — Duplica orcamento como NOVA OPCAO PARALELA.
   *
   * Diferente de renegotiate: original NAO eh marcado como REJECTED, original
   * permanece ativo. Permite ao operador apresentar varias opcoes ao paciente
   * (ex: opcao 1 — a vista 5%, opcao 2 — 10x s/ juros, opcao 3 — 12x c/ juros)
   * com os MESMOS procedimentos clinicos, variando so condicoes comerciais.
   *
   * O novo quote inicia como DRAFT, sem desconto/cupom/payment_terms — operador
   * configura cada um separadamente. Items copiados na ordem original, com
   * dentist_id e payment_method (por item) preservados.
   *
   * Permitido em qualquer status do original — inclusive ACCEPTED/REJECTED
   * (caso queira "ressuscitar" um plano antigo como nova opcao). Nao cria
   * snapshot porque nao altera o original.
   */
  async duplicateAsOption(
    quoteId: string,
    tenantId: string,
    actorUserId: string,
  ) {
    const original = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        patient: { select: { tenant_id: true } },
        items: { orderBy: { order_index: 'asc' } },
      },
    });
    if (!original) throw new NotFoundException('Orcamento nao encontrado');
    if (original.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
    if (original.deleted_at) {
      throw new BadRequestException(
        'Nao eh possivel duplicar orcamento deletado',
      );
    }

    // Recalcula subtotal a partir dos items copiados (defesa caso original
    // esteja com totais inconsistentes — afinal o usuario pode editar depois)
    const subtotal = original.items.reduce(
      (acc: number, i: { total_price: unknown }) => acc + Number(i.total_price),
      0,
    );

    // Onda 14.19 — duplicateAsOption tambem cria quote NOVO; precisa de
    // quote_number proprio pra aparecer com identificador (#NNN) nas listas.
    const lastForTenant = await this.prisma.quote.findFirst({
      where: { patient: { tenant_id: tenantId } },
      orderBy: { quote_number: 'desc' },
      select: { quote_number: true },
    });
    const nextQuoteNumber = (lastForTenant?.quote_number || 0) + 1;
    const newQuote = await this.prisma.quote.create({
      data: {
        patient_id: original.patient_id,
        created_by_user_id: actorUserId,
        status: 'DRAFT',
        quote_number: nextQuoteNumber,
        valid_until: (() => {
          const d = new Date();
          d.setDate(d.getDate() + 30);
          return d;
        })(),
        // Copia notes pra preservar contexto clinico, mas zera condicoes
        // comerciais — operador define do zero (ex: "10x sem juros")
        notes: original.notes,
        payment_terms: null,
        // Sem desconto/cupom — operador aplica conforme a opcao
        subtotal,
        discount_percent: 0,
        discount_value: 0,
        total_value: subtotal,
        coupon_id: null,
        // renegotiated_from_id NAO eh setado — opcoes sao paralelas, nao sucessoras
        items: {
          create: original.items.map(
            (
              i: {
                procedure_id: string;
                tooth_fdi: string | null;
                quantity: number;
                unit_price: unknown;
                total_price: unknown;
                notes: string | null;
                dentist_id: string | null;
                payment_method: string | null;
                installments_count: number | null;
              },
              idx: number,
            ) => ({
              procedure_id: i.procedure_id,
              tooth_fdi: i.tooth_fdi,
              quantity: i.quantity,
              unit_price: i.unit_price as never,
              total_price: i.total_price as never,
              notes: i.notes,
              order_index: idx,
              dentist_id: i.dentist_id,
              // payment_method por item nao copia — operador define no novo quote
              payment_method: null,
              installments_count: null,
            }),
          ),
        },
      },
      include: {
        items: { include: { procedure: { select: { id: true, name: true } } } },
      },
    });

    this.logger.log(
      `[DUPLICATE-AS-OPTION] Quote ${quoteId} duplicado -> nova opcao DRAFT ${newQuote.id}`,
    );
    return newQuote;
  }

  // ─── Helper ──────────────────────────────────────────────────

  private async assertQuoteBelongsToTenant(quoteId: string, tenantId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      select: { id: true, patient: { select: { tenant_id: true } } },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
  }
}
