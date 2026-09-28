import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateProcedureConsumableDto } from './dto/procedure-consumable.dto';
import { StockMovementsService } from './stock-movements.service';

@Injectable()
export class ProcedureConsumablesService {
  private readonly logger = new Logger(ProcedureConsumablesService.name);

  constructor(
    private prisma: PrismaService,
    // Reusa a política de saldo negativo da clínica (fase 1) — uma fonte só.
    private movements: StockMovementsService,
  ) {}

  // ─── Consumo de insumo pela VENDA (fase 2) ──────────────────────────────
  // O vinculo procedimento->insumo existia no cadastro desde sempre e NUNCA era
  // usado: a clinica cadastrava "limpeza gasta 1 kit" e o estoque nunca descia.
  // Aqui ele vira baixa de verdade, a partir da venda de balcao.

  /** Soma os insumos de uma lista de procedimentos (qtd do vinculo x qtd vendida). */
  private async resolveNeeds(
    tenantId: string,
    items: Array<{ procedure_id: string; quantity?: number }>,
  ) {
    const procIds = Array.from(new Set(items.map((i) => i.procedure_id).filter(Boolean)));
    if (procIds.length === 0) return [];

    const vinculos = await this.prisma.procedureConsumable.findMany({
      where: { procedure_id: { in: procIds }, procedure: { tenant_id: tenantId } },
      include: {
        product: {
          select: { id: true, name: true, unit: true, current_stock: true, cost_price: true, active: true },
        },
        procedure: { select: { id: true, name: true } },
      },
    });
    if (vinculos.length === 0) return [];

    // Quantas vezes cada procedimento foi vendido (item com dente vira 1 por dente,
    // entao a MESMA procedure aparece varias vezes na lista — soma tudo).
    const vezes = new Map<string, number>();
    for (const i of items) {
      vezes.set(i.procedure_id, (vezes.get(i.procedure_id) || 0) + (Number(i.quantity) || 1));
    }

    // Agrega por PRODUTO: dois procedimentos da mesma venda podem gastar o mesmo insumo.
    const porProduto = new Map<string, {
      product_id: string;
      name: string;
      unit: string;
      needed: number;
      current_stock: number;
      cost_price: number | null;
      active: boolean;
      origens: string[];
    }>();
    for (const v of vinculos) {
      const mult = vezes.get(v.procedure_id) || 0;
      if (mult <= 0) continue;
      const need = Number(v.quantity) * mult;
      const acc = porProduto.get(v.product_id);
      if (acc) {
        acc.needed += need;
        if (!acc.origens.includes(v.procedure.name)) acc.origens.push(v.procedure.name);
      } else {
        porProduto.set(v.product_id, {
          product_id: v.product_id,
          name: v.product.name,
          unit: v.product.unit,
          needed: need,
          current_stock: Number(v.product.current_stock),
          cost_price: v.product.cost_price != null ? Number(v.product.cost_price) : null,
          active: v.product.active,
          origens: [v.procedure.name],
        });
      }
    }
    return Array.from(porProduto.values()).map((r) => ({
      ...r,
      needed: +r.needed.toFixed(3),
      falta: +Math.max(0, r.needed - r.current_stock).toFixed(3),
      custo_total: r.cost_price != null ? +(r.cost_price * r.needed).toFixed(2) : null,
    }));
  }

  /**
   * PREVIEW: o que sairia do estoque se esta venda fosse fechada agora.
   * A tela usa pra mostrar o bloco "vai sair do estoque" e avisar de falta ANTES
   * de criar o orcamento — ninguem descobre que faltou material depois de cobrar
   * o paciente.
   */
  async previewConsumption(
    tenantId: string,
    items: Array<{ procedure_id: string; quantity?: number }>,
  ) {
    const needs = await this.resolveNeeds(tenantId, items);
    const bloqueiaSemSaldo = await this.movements.blocksNegativeStock(tenantId);
    const faltando = needs.filter((n) => n.falta > 0);
    return {
      items: needs,
      custo_total: needs.reduce((s, n) => s + (n.custo_total || 0), 0),
      tem_falta: faltando.length > 0,
      // A tela so precisa saber se ESTA venda seria recusada — o motivo detalhado
      // sai por item em `items[].falta`.
      bloqueado: bloqueiaSemSaldo && faltando.length > 0,
      bloqueia_sem_saldo: bloqueiaSemSaldo,
    };
  }

  /**
   * COMMIT: gera as SAIDAs de estoque da venda, tudo numa transacao.
   *
   * IDEMPOTENTE por `quote_id`: a tela de venda rapida faz varias chamadas em
   * sequencia e pode ser reexecutada (retry, duplo clique, aba recarregada) —
   * sem isto, a mesma venda baixaria o estoque duas vezes.
   *
   * Respeita o botao da clinica: com o bloqueio LIGADO, falta de saldo recusa a
   * baixa inteira (nao baixa metade). Com ele desligado, baixa tudo e o saldo
   * fica negativo, marcado pra conferencia.
   */
  async commitConsumption(
    tenantId: string,
    userId: string | undefined,
    data: {
      items: Array<{ procedure_id: string; quantity?: number }>;
      quote_id?: string | null;
      notes?: string | null;
    },
  ) {
    const quoteId = data.quote_id || null;

    if (quoteId) {
      const ja = await this.prisma.stockMovement.findFirst({
        where: { tenant_id: tenantId, quote_id: quoteId },
        select: { id: true },
      });
      if (ja) {
        this.logger.log(`[ESTOQUE] Consumo da venda ${quoteId} ja registrado — ignorando (idempotente)`);
        return { ok: true, idempotent: true, movimentos: 0 };
      }
    }

    const needs = await this.resolveNeeds(tenantId, data.items);
    if (needs.length === 0) return { ok: true, movimentos: 0, sem_insumo: true };

    const faltando = needs.filter((n) => n.falta > 0);
    if (faltando.length > 0 && (await this.movements.blocksNegativeStock(tenantId))) {
      throw new BadRequestException(
        'Estoque insuficiente: ' +
          faltando
            .map((f) => `${f.name} (precisa ${f.needed}${f.unit}, tem ${f.current_stock}${f.unit})`)
            .join('; ') +
          '. Dê entrada no produto ou desligue "bloquear saída sem saldo" em Estoque.',
      );
    }

    const notes = data.notes?.trim() || 'Baixa automática pela venda';
    const criados = await this.prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      for (const n of needs) {
        const mov = await tx.stockMovement.create({
          data: {
            tenant_id: tenantId,
            product_id: n.product_id,
            type: 'SAIDA',
            quantity: new Prisma.Decimal(n.needed),
            unit_cost: n.cost_price != null ? new Prisma.Decimal(n.cost_price) : undefined,
            total_cost: n.custo_total != null ? new Prisma.Decimal(n.custo_total) : undefined,
            quote_id: quoteId,
            notes: `${notes} — ${n.origens.join(', ')}`,
            performed_by_user_id: userId,
          },
          select: { id: true },
        });
        // decrement no BANCO (mesma razao do fix da fase 1: nada de ler-e-escrever)
        await tx.product.update({
          where: { id: n.product_id },
          data: { current_stock: { decrement: new Prisma.Decimal(n.needed) } },
        });
        ids.push(mov.id);
      }
      return ids;
    });

    this.logger.log(
      `[ESTOQUE] Venda ${quoteId ?? '(sem orçamento)'} consumiu ${criados.length} insumo(s)` +
      (faltando.length > 0 ? ` — ${faltando.length} ficou(aram) com saldo negativo` : ''),
    );
    return { ok: true, movimentos: criados.length, saldo_negativo: faltando.length };
  }


  async create(tenantId: string, procedureId: string, dto: CreateProcedureConsumableDto) {
    const procedure = await this.prisma.procedure.findFirst({
      where: { id: procedureId, tenant_id: tenantId },
    });
    if (!procedure) throw new NotFoundException('Procedimento nao encontrado');

    const product = await this.prisma.product.findFirst({
      where: { id: dto.product_id, tenant_id: tenantId },
    });
    if (!product) throw new NotFoundException('Produto nao encontrado');

    return this.prisma.procedureConsumable.upsert({
      where: { procedure_id_product_id: { procedure_id: procedureId, product_id: dto.product_id } },
      create: {
        procedure_id: procedureId,
        product_id: dto.product_id,
        quantity: new Prisma.Decimal(dto.quantity),
        notes: dto.notes,
      },
      update: {
        quantity: new Prisma.Decimal(dto.quantity),
        notes: dto.notes,
      },
    });
  }

  async findByProcedure(tenantId: string, procedureId: string) {
    const procedure = await this.prisma.procedure.findFirst({
      where: { id: procedureId, tenant_id: tenantId },
    });
    if (!procedure) throw new NotFoundException('Procedimento nao encontrado');

    return this.prisma.procedureConsumable.findMany({
      where: { procedure_id: procedureId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            brand: true,
            unit: true,
            current_stock: true,
            cost_price: true,
          },
        },
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const consumable = await this.prisma.procedureConsumable.findUnique({
      where: { id },
      include: { procedure: { select: { tenant_id: true } } },
    });
    if (!consumable) throw new NotFoundException('Vinculo nao encontrado');
    if (consumable.procedure.tenant_id !== tenantId) {
      throw new BadRequestException('Vinculo pertence a outro tenant');
    }
    await this.prisma.procedureConsumable.delete({ where: { id } });
    return { ok: true };
  }
}
