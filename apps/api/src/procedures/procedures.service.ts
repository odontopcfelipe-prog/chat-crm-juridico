import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { FileStorageService } from '../media/filesystem.service';
import { registrarAuditoria } from '../common/utils/audit-log.util';
import type { AparenciaVendaDto } from './dto/procedure.dto';

// Mesmas regras da foto de produto do estoque.
const FOTO_MIMES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const FOTO_MAX_BYTES = 2 * 1024 * 1024;

const CHAVE_APARENCIA_VENDA = 'VENDA_RAPIDA_APARENCIA';

export type EstoqueDoItem = { infinito: true } | { infinito: false; quantidade: number; limitado_por: string };

/**
 * Quantas vendas o estoque aguenta. Sem material ligado o item é "infinito" (como o serviço
 * feito por encomenda); com material, manda o que acaba primeiro.
 */
export function estoqueDoItem(
  consumiveis: Array<{ quantity: unknown; product: { name: string; current_stock: unknown } }>,
): EstoqueDoItem {
  let melhor: { infinito: false; quantidade: number; limitado_por: string } | null = null;
  for (const c of consumiveis) {
    // Em milésimos, como a baixa da venda: em ponto flutuante 0,3 / 0,1 dá 2,99... e somem vendas.
    const porVez = Math.round(Number(c.quantity) * 1000);
    if (!(porVez > 0)) continue;
    const quantidade = Math.max(0, Math.floor(Math.round(Number(c.product.current_stock) * 1000) / porVez));
    if (!melhor || quantidade < melhor.quantidade) {
      melhor = { infinito: false, quantidade, limitado_por: c.product.name };
    }
  }
  return melhor ?? { infinito: true };
}

@Injectable()
export class ProceduresService {
  constructor(
    private prisma: PrismaService,
    private fileStorage: FileStorageService,
  ) {}

  async create(tenantId: string, data: Omit<Prisma.ProcedureUncheckedCreateInput, 'tenant_id'>) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    await this.assertSpecialtyDaConta(data.specialty_id, tenantId);
    return this.prisma.procedure.create({ data: { ...data, tenant_id: tenantId } });
  }

  async findAll(
    tenantId: string,
    opts: { specialtyId?: string; includeInactive?: boolean; search?: string } = {},
  ) {
    return this.prisma.procedure.findMany({
      where: {
        tenant_id: tenantId,
        ...(opts.includeInactive ? {} : { active: true }),
        ...(opts.specialtyId ? { specialty_id: opts.specialtyId } : {}),
        ...(opts.search
          ? {
              OR: [
                { name: { contains: opts.search, mode: 'insensitive' } },
                { code_tuss: { contains: opts.search } },
                { internal_code: { contains: opts.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ specialty_id: 'asc' }, { name: 'asc' }],
      include: {
        specialty: { select: { id: true, name: true, icon: true } },
        // Tabela de Preços: quantos materiais do estoque o procedimento gasta (botão "Materiais").
        _count: { select: { consumables: true } },
      },
    });
  }

  /** Aba Produtos da Venda Rápida: os itens ativos da conta, com preço, foto e estoque. */
  async catalogo(tenantId: string) {
    const itens = await this.prisma.procedure.findMany({
      where: { tenant_id: tenantId, active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        base_price: true,
        promo_price: true,
        photo_url: true,
        updated_at: true,
        quick_sale: true,
        featured: true,
        consumables: { select: { quantity: true, product: { select: { name: true, current_stock: true } } } },
      },
    });
    return itens.map(({ consumables, ...item }) => ({
      ...item,
      base_price: Number(item.base_price),
      promo_price: item.promo_price === null ? null : Number(item.promo_price),
      qtd_materiais: consumables.length,
      estoque: estoqueDoItem(consumables),
    }));
  }

  /** Edição básica da Venda Rápida, desta conta. Sem nada salvo volta vazio e a tela usa o padrão. */
  async aparenciaVenda(tenantId: string): Promise<Partial<AparenciaVendaDto>> {
    const linha = await this.prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key: CHAVE_APARENCIA_VENDA } },
    });
    if (!linha) return {};
    try {
      return JSON.parse(linha.value);
    } catch {
      return {};
    }
  }

  async salvarAparenciaVenda(tenantId: string, dto: AparenciaVendaDto): Promise<AparenciaVendaDto> {
    const valor: AparenciaVendaDto = {
      cor_cabecalho: dto.cor_cabecalho,
      cor_produtos: dto.cor_produtos,
      cor_destaque: dto.cor_destaque,
      cor_rodape: dto.cor_rodape,
      tamanho_foto: dto.tamanho_foto,
    };
    const texto = JSON.stringify(valor);
    await this.prisma.tenantSetting.upsert({
      where: { tenant_id_key: { tenant_id: tenantId, key: CHAVE_APARENCIA_VENDA } },
      create: { tenant_id: tenantId, key: CHAVE_APARENCIA_VENDA, value: texto },
      update: { value: texto },
    });
    return valor;
  }

  async findOne(id: string, tenantId: string) {
    const proc = await this.prisma.procedure.findUnique({
      where: { id },
      include: { specialty: { select: { id: true, name: true } } },
    });
    if (!proc) throw new NotFoundException('Procedimento nao encontrado');
    if (proc.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return proc;
  }

  async update(id: string, tenantId: string, data: Prisma.ProcedureUncheckedUpdateInput, actorUserId?: string) {
    const atual = await this.prisma.procedure.findUnique({
      where: { id },
      select: { tenant_id: true, base_price: true, promo_price: true },
    });
    if (!atual) throw new NotFoundException('Procedimento nao encontrado');
    if (atual.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    await this.assertSpecialtyDaConta(data.specialty_id, tenantId);

    const antes = { base_price: Number(atual.base_price), promo_price: atual.promo_price === null ? null : Number(atual.promo_price) };
    const base = data.base_price !== undefined ? Number(data.base_price) : antes.base_price;
    const dados: Prisma.ProcedureUncheckedUpdateInput = { ...data };
    if (data.promo_price !== undefined && data.promo_price !== null) {
      if (Number(data.promo_price) >= base) {
        throw new BadRequestException('O preço promocional tem que ser menor que o preço.');
      }
    } else if (data.promo_price === undefined && antes.promo_price !== null && antes.promo_price >= base) {
      // O preço baixou até a promoção (ou o reajuste em massa passou dela): não é mais promoção.
      dados.promo_price = null;
    }

    const salvo = await this.prisma.procedure.update({ where: { id }, data: dados });

    // Preço e promoção são o que a recepção cobra sem passar pelo Validar: fica o rastro.
    const depois = { base_price: Number(salvo.base_price), promo_price: salvo.promo_price === null ? null : Number(salvo.promo_price) };
    if (depois.base_price !== antes.base_price || depois.promo_price !== antes.promo_price) {
      await registrarAuditoria(this.prisma, {
        tenantId,
        actorUserId: actorUserId ?? null,
        entity: 'PROCEDURE',
        entityId: id,
        action: 'PRECO_ALTERADO',
        before: antes,
        after: depois,
      });
    }
    return salvo;
  }

  async remove(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);
    // Soft delete para preservar referencias em QuoteItem/TreatmentPlanItem
    return this.prisma.procedure.update({ where: { id }, data: { active: false } });
  }

  // ─── Foto do item (Venda Rápida) ─────────────────────────────────────────

  /** Salva a foto no filesystem (procedures/{id}.ext) e grava o caminho. */
  async updatePhoto(id: string, tenantId: string, buffer: Buffer, mimeType: string) {
    const ext = FOTO_MIMES[mimeType?.toLowerCase()];
    await this.assertBelongsToTenant(id, tenantId);
    if (!ext) throw new BadRequestException('Tipo de imagem nao suportado. Use JPEG, PNG ou WebP.');
    if (buffer.length > FOTO_MAX_BYTES) throw new BadRequestException('Imagem muito grande. Maximo 2 MB.');

    // Limpa a versao anterior salva em outra extensao.
    for (const antiga of new Set(Object.values(FOTO_MIMES))) {
      if (antiga !== ext) await this.fileStorage.delete(`procedures/${id}.${antiga}`).catch(() => {});
    }
    const caminho = `procedures/${id}.${ext}`;
    await this.fileStorage.write(caminho, buffer);
    return this.prisma.procedure.update({
      where: { id },
      data: { photo_url: caminho },
      select: { id: true, photo_url: true, updated_at: true },
    });
  }

  /** Bytes da foto, só do item da própria conta. null = sem foto (ou arquivo sumiu do disco). */
  async getPhoto(id: string, tenantId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const item = await this.prisma.procedure.findFirst({
      where: { id, tenant_id: tenantId },
      select: { photo_url: true },
    });
    if (!item?.photo_url) return null;
    const buffer = await this.fileStorage.tryRead(item.photo_url);
    if (!buffer) return null;
    const ext = item.photo_url.split('.').pop()?.toLowerCase();
    return { buffer, mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
  }

  async removePhoto(id: string, tenantId: string) {
    const item = await this.prisma.procedure.findFirst({
      where: { id, tenant_id: tenantId },
      select: { photo_url: true },
    });
    if (!item) throw new NotFoundException('Procedimento nao encontrado');
    if (item.photo_url) await this.fileStorage.delete(item.photo_url).catch(() => {});
    return this.prisma.procedure.update({
      where: { id },
      data: { photo_url: null },
      select: { id: true, photo_url: true, updated_at: true },
    });
  }

  /**
   * Grupo (especialidade) só da própria conta. Sem filtro de ativo: a tela de
   * edição reenvia o grupo atual, que pode estar desativado. null/'' seguem como hoje.
   */
  private async assertSpecialtyDaConta(specialtyId: unknown, tenantId: string) {
    if (typeof specialtyId !== 'string' || !specialtyId) return;
    const row = await this.prisma.specialty.findUnique({
      where: { id: specialtyId },
      select: { tenant_id: true },
    });
    if (row && row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const row = await this.prisma.procedure.findUnique({
      where: { id },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Procedimento nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }
}
