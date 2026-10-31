import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { isLabTenant } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CATEGORIAS_ANTIGAS, NOME_CATEGORIA_MAX, normalizarCategoria } from './product-categories';

/** Categorias de produto por conta: regras e lista antiga em product-categories.ts. */
@Injectable()
export class ProductCategoriesService {
  private readonly logger = new Logger(ProductCategoriesService.name);
  /** Contas já preparadas neste processo (conversão + sugestão inicial são idempotentes). */
  private readonly preparadas = new Set<string>();

  constructor(private prisma: PrismaService) {}

  /**
   * Uma vez por conta (por processo): troca os códigos antigos dos produtos pelo
   * nome e, se a conta nunca teve categoria, cria a sugestão inicial.
   */
  async ensureSeeded(tenantId: string): Promise<void> {
    if (this.preparadas.has(tenantId)) return;

    const emUso = await this.prisma.product.findMany({
      where: { tenant_id: tenantId, category: { in: Object.keys(CATEGORIAS_ANTIGAS) } },
      distinct: ['category'],
      select: { category: true },
    });
    for (const { category } of emUso) {
      if (!category) continue;
      await this.prisma.product.updateMany({
        where: { tenant_id: tenantId, category },
        data: { category: CATEGORIAS_ANTIGAS[category] },
      });
    }

    const jaTem = await this.prisma.productCategory.count({ where: { tenant_id: tenantId } });
    if (jaTem === 0) {
      const lab = await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
      const nomes = lab
        ? emUso.map((p) => CATEGORIAS_ANTIGAS[p.category as string]).filter(Boolean)
        : Object.values(CATEGORIAS_ANTIGAS);
      if (nomes.length) {
        await this.prisma.productCategory.createMany({
          data: nomes.map((name) => ({ tenant_id: tenantId, name })),
          skipDuplicates: true,
        });
      }
    }
    this.preparadas.add(tenantId);
  }

  /** Categorias ativas da conta, com quantos produtos ativos usam cada uma. */
  async list(tenantId: string) {
    await this.ensureSeeded(tenantId);
    const [categorias, contagem] = await Promise.all([
      this.prisma.productCategory.findMany({
        where: { tenant_id: tenantId, active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.product.groupBy({
        by: ['category'],
        where: { tenant_id: tenantId, active: true, category: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const porNome = new Map(contagem.map((c) => [c.category, c._count._all]));
    return categorias.map((c) => ({ ...c, products: porNome.get(c.name) ?? 0 }));
  }

  async create(tenantId: string, nome: string) {
    // Antes de criar: a primeira categoria criada não pode pular a sugestão inicial.
    await this.ensureSeeded(tenantId);
    const name = this.validarNome(nome);
    const existente = await this.acharPorNome(tenantId, name);
    if (existente?.active) throw new BadRequestException(`Já existe a categoria "${existente.name}".`);
    if (existente) {
      // Removida antes: volta para a lista (o nome único não deixa criar outra igual)
      return this.prisma.productCategory.update({
        where: { id: existente.id },
        data: { active: true },
        select: { id: true, name: true },
      });
    }
    try {
      return await this.prisma.productCategory.create({
        data: { tenant_id: tenantId, name },
        select: { id: true, name: true },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException(`Já existe a categoria "${name}".`);
      throw e;
    }
  }

  /** Renomeia a categoria e, junto, o nome gravado nos produtos da conta. */
  async rename(id: string, tenantId: string, nome: string) {
    const atual = await this.prisma.productCategory.findFirst({
      where: { id, tenant_id: tenantId, active: true },
    });
    if (!atual) throw new NotFoundException('Categoria nao encontrada');
    const name = this.validarNome(nome);
    if (name === atual.name) return { id: atual.id, name: atual.name };

    const outra = await this.acharPorNome(tenantId, name);
    if (outra && outra.id !== atual.id && outra.active) {
      throw new BadRequestException(`Já existe a categoria "${outra.name}".`);
    }
    // Nome de uma categoria removida antes: a linha removida sai e esta fica com o nome
    const liberarNome = outra && outra.id !== atual.id
      ? [this.prisma.productCategory.delete({ where: { id: outra.id } })]
      : [];
    await this.prisma.$transaction([
      ...liberarNome,
      this.prisma.productCategory.update({
        where: { id: atual.id },
        data: { name },
      }),
      this.prisma.product.updateMany({
        where: { tenant_id: tenantId, category: atual.name },
        data: { category: name },
      }),
    ]);
    return { id: atual.id, name };
  }

  /** Tira da lista. Os produtos continuam com o nome gravado. */
  async remove(id: string, tenantId: string) {
    const atual = await this.prisma.productCategory.findFirst({
      where: { id, tenant_id: tenantId, active: true },
      select: { id: true },
    });
    if (!atual) throw new NotFoundException('Categoria nao encontrada');
    return this.prisma.productCategory.update({
      where: { id: atual.id },
      data: { active: false },
      select: { id: true, name: true },
    });
  }

  private validarNome(nome: string): string {
    const name = normalizarCategoria(nome);
    if (!name) throw new BadRequestException('Nome da categoria e obrigatorio');
    if (name.length > NOME_CATEGORIA_MAX) {
      throw new BadRequestException(`Nome da categoria com no maximo ${NOME_CATEGORIA_MAX} caracteres`);
    }
    return name;
  }

  private acharPorNome(tenantId: string, name: string) {
    return this.prisma.productCategory.findFirst({
      where: { tenant_id: tenantId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true, active: true },
    });
  }
}
