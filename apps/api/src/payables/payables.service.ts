import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceiroService } from '../financeiro/financeiro.service';
import { CaixaService } from '../caixa/caixa.service';
import { CreateInstallmentPlanDto, CreatePayableDto, UpdatePayableDto, PayViaCaixaDto, CreateCompanyDto, UpdateCompanyDto } from './payables.dto';

/**
 * Contas a Pagar (Accounts Payable).
 *
 * NÃO cria financeiro paralelo: tudo é FinancialTransaction type='DESPESA' com
 * source='PAYABLES' (pra a tela mostrar SÓ o que nasce aqui — não comissão,
 * diária, caixa ou saque de afiliado). Reusa o FinanceiroService pros CRUD e
 * adiciona o gerador de PARCELAMENTO EXATO.
 *
 * Acesso: o controller inteiro exige @RequiresPermission('manage_payables').
 */
const SOURCE = 'PAYABLES';
const CAIXA_METHODS = ['DINHEIRO', 'CARTAO', 'PIX', 'TRANSFERENCIA'];

@Injectable()
export class PayablesService {
  private readonly logger = new Logger(PayablesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly financeiro: FinanceiroService,
    private readonly caixa: CaixaService,
  ) {}

  // ─── Datas (naive-UTC de Maceió: ancora ao meio-dia UTC pra não pular dia) ──
  private parseLocalDate(s: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) throw new BadRequestException('Data inválida (use YYYY-MM-DD)');
    const [yy, mm, dd] = [+m[1], +m[2], +m[3]];
    const d = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
    // rejeita data de calendário inexistente (ex.: 30/02, 31/04) que o Date normaliza
    if (d.getUTCFullYear() !== yy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) {
      throw new BadRequestException('Data inválida (dia/mês inexistente)');
    }
    return d;
  }

  private addMonthsNoonUTC(base: Date, months: number): Date {
    const y = base.getUTCFullYear();
    const mo = base.getUTCMonth();
    const day = base.getUTCDate();
    const maxDay = new Date(Date.UTC(y, mo + months + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, mo + months, Math.min(day, maxDay), 12, 0, 0));
  }

  private requireTenant(tenantId?: string): string {
    if (!tenantId) throw new BadRequestException('Tenant não identificado');
    return tenantId;
  }

  /** Carrega a transação garantindo tenant + que é DESPESA de origem PAYABLES.
   *  Sem o filtro de source, um id forjado de comissão/diária/afiliado (source
   *  null, mesmo tenant) passaria e poderia ser editado/cancelado por aqui. */
  private async assertPayable(id: string, tenantId: string) {
    const rec = await this.prisma.financialTransaction.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Conta não encontrada');
    if (rec.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado a este recurso');
    if (rec.type !== 'DESPESA') throw new ForbiddenException('Este lançamento não é uma conta a pagar');
    if ((rec as any).source !== SOURCE) throw new NotFoundException('Conta não encontrada');
    return rec;
  }

  // ─── Lista / categorias (só DESPESA de origem PAYABLES) ────────────────────
  async listPayables(params: {
    tenantId?: string;
    companyId?: string;
    status?: string;
    category?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }) {
    const tenantId = this.requireTenant(params.tenantId);
    const companyId = await this.resolveCompanyId(params.companyId, tenantId); // null = clínica
    return this.financeiro.findAllTransactions({
      tenantId,
      type: 'DESPESA',
      source: SOURCE,
      companyId, // null = clínica (padrão) | id = outra empresa
      periodField: 'due_date', // competência da conta a pagar = vencimento
      status: params.status,
      category: params.category,
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit,
      offset: params.offset,
    } as any);
  }

  /** "Gastos do dia" = TODAS as saídas AVULSAS do escopo (não recorrentes/parcelas,
   *  que são as Contas Fixas). Diferente de listPayables: NÃO filtra por source, então
   *  na clínica inclui comissão/diária/caixa/afiliado; nas outras empresas, os gastos
   *  avulsos daquela empresa. */
  async listGastos(params: {
    tenantId?: string;
    companyId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }) {
    const tenantId = this.requireTenant(params.tenantId);
    const companyId = await this.resolveCompanyId(params.companyId, tenantId);
    return this.financeiro.findAllTransactions({
      tenantId,
      type: 'DESPESA',
      companyId,
      loose: true,
      periodField: 'due_date',
      status: params.status,
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit,
      offset: params.offset,
    } as any);
  }

  /** Categorias de DESPESA — semeia lazy se o tenant ainda não tiver nenhuma. */
  async getCategories(tenantId?: string) {
    const tid = this.requireTenant(tenantId);
    const count = await this.prisma.financialCategory.count({ where: { tenant_id: tid } });
    if (count === 0) {
      try { await this.financeiro.seedDefaultCategories(tid); } catch { /* corrida de seed — segue */ }
    }
    const cats = await this.financeiro.findAllCategories(tid);
    return cats.filter((c: any) => c.type === 'DESPESA');
  }

  /** Contas do caixa (CashAccount) pro seletor de "onde saiu o dinheiro". */
  async getAccounts(tenantId?: string) {
    const tid = this.requireTenant(tenantId);
    const accounts = await this.caixa.listAccounts(tid);
    return accounts.filter((a: any) => a.active);
  }

  // ─── Empresas (multi-empresa; a clínica é o padrão = company_id null) ───────
  /** Valida a empresa e devolve o id (ou null = clínica). Anti-IDOR por tenant. */
  private async resolveCompanyId(companyId: string | undefined | null, tenantId: string): Promise<string | null> {
    if (!companyId) return null; // clínica (padrão)
    const c = await this.prisma.payableCompany.findUnique({ where: { id: companyId } });
    if (!c || c.tenant_id !== tenantId) throw new NotFoundException('Empresa não encontrada');
    return companyId;
  }

  listCompanies(tenantId?: string) {
    const tid = this.requireTenant(tenantId);
    return this.prisma.payableCompany.findMany({
      where: { tenant_id: tid, active: true },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });
  }

  createCompany(dto: CreateCompanyDto, tenantId?: string) {
    const tid = this.requireTenant(tenantId);
    return this.prisma.payableCompany.create({ data: { tenant_id: tid, name: dto.name.trim() } });
  }

  async updateCompany(id: string, dto: UpdateCompanyDto, tenantId?: string) {
    const tid = this.requireTenant(tenantId);
    const c = await this.prisma.payableCompany.findUnique({ where: { id } });
    if (!c || c.tenant_id !== tid) throw new NotFoundException('Empresa não encontrada');
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.active !== undefined) data.active = dto.active;
    return this.prisma.payableCompany.update({ where: { id }, data });
  }

  // ─── Criar / editar / pagar / excluir ──────────────────────────────────────
  async createPayable(dto: CreatePayableDto, tenantId: string, actorId?: string) {
    const tid = this.requireTenant(tenantId);
    const companyId = await this.resolveCompanyId(dto.company_id, tid); // null = clínica
    const isClinic = !companyId;
    // Gasto pago via caixa: SÓ na clínica (as outras empresas não mexem no caixa).
    // account_id + status PAGO → debita a gaveta do dia (entra no fechamento).
    if (isClinic && dto.account_id && dto.status === 'PAGO') {
      const method = dto.payment_method || 'DINHEIRO';
      if (!CAIXA_METHODS.includes(method)) {
        throw new BadRequestException('Forma de pagamento inválida para o caixa (use DINHEIRO/CARTAO/PIX/TRANSFERENCIA)');
      }
      return this.caixa.addMovement(
        tid,
        actorId || '',
        {
          direction: 'SAIDA',
          amount: dto.amount,
          method,
          account_id: dto.account_id,
          description: dto.description,
          category: dto.category,
        } as any,
        { source: SOURCE },
      );
    }
    // Despesa gerencial (pendente, paga sem caixa, ou de outra empresa)
    const { account_id, company_id, ...rest } = dto as any;
    return this.financeiro.createTransaction({
      ...rest,
      type: 'DESPESA',
      source: SOURCE,
      company_id: companyId,
      visible_to_dentist: false,
      tenant_id: tid,
      actor_id: actorId,
    });
  }

  /** Paga uma conta a pagar existente debitando o caixa do dia (só clínica). */
  async payViaCaixa(id: string, dto: PayViaCaixaDto, tenantId: string, actorId?: string) {
    const tid = this.requireTenant(tenantId);
    const rec = await this.assertPayable(id, tid);
    if ((rec as any).company_id) {
      throw new BadRequestException('Contas de outras empresas não entram no caixa da clínica — use "marcar como pago".');
    }
    return this.caixa.payExistingViaCaixa(id, tid, actorId || '', {
      account_id: dto.account_id,
      payment_method: dto.payment_method,
    });
  }

  async updatePayable(id: string, dto: UpdatePayableDto, tenantId: string, actorId?: string) {
    const tid = this.requireTenant(tenantId);
    await this.assertPayable(id, tid);
    return this.financeiro.updateTransaction(id, dto as any, tid, actorId);
  }

  async deletePayable(id: string, tenantId: string, actorId?: string) {
    const tid = this.requireTenant(tenantId);
    await this.assertPayable(id, tid);
    return this.financeiro.deleteTransaction(id, tid, actorId);
  }

  // ─── Parcelamento EXATO (compra em N vezes) ───────────────────────────────
  async createInstallmentPlan(dto: CreateInstallmentPlanDto, tenantId: string, actorId?: string) {
    const tid = this.requireTenant(tenantId);
    const companyId = await this.resolveCompanyId(dto.company_id, tid); // null = clínica
    const n = Math.trunc(dto.installments);
    if (!(n >= 1 && n <= 60)) {
      throw new BadRequestException('Número de parcelas deve ser entre 1 e 60');
    }
    const totalCents = Math.round(Number(dto.total_amount) * 100);
    if (!(totalCents > 0)) {
      throw new BadRequestException('Valor total deve ser maior que zero');
    }
    if (totalCents < n) {
      throw new BadRequestException('Valor insuficiente: cada parcela precisa de ao menos R$0,01 (reduza o número de parcelas)');
    }

    const firstDue = this.parseLocalDate(dto.first_due_date);

    // Valores EXATOS em centavos: sobra vai na ÚLTIMA parcela (soma == total).
    const baseCents = Math.floor(totalCents / n);
    const remainderCents = totalCents - baseCents * n;
    const groupId = randomUUID(); // âncora do grupo (parent_transaction_id de todas)

    const rows = Array.from({ length: n }, (_, i) => {
      const cents = i === n - 1 ? baseCents + remainderCents : baseCents;
      const dueDate = this.addMonthsNoonUTC(firstDue, i);
      return {
        tenant_id: tid,
        source: SOURCE,
        type: 'DESPESA',
        category: dto.category,
        description: n > 1 ? `${dto.description} (${i + 1}/${n})` : dto.description,
        amount: cents / 100,
        date: dueDate,
        due_date: dueDate,
        payment_method: dto.payment_method ?? null,
        status: 'PENDENTE',
        visible_to_dentist: false,
        notes: dto.notes ?? null,
        parent_transaction_id: groupId,
        installment_sequence: i + 1,
        installment_total: n,
        company_id: companyId,
      };
    });

    await this.prisma.$transaction(
      rows.map((data) => this.prisma.financialTransaction.create({ data: data as any })),
    );

    await this.financeiro.logAction(actorId || null, 'CONTA_PARCELADA_CRIADA', groupId, tid, {
      descricao: dto.description, categoria: dto.category,
      total: totalCents / 100, parcelas: n, primeira_venc: dto.first_due_date,
    });
    this.logger.log(`[PAYABLES] Parcelamento: "${dto.description}" R$${(totalCents / 100).toFixed(2)} em ${n}x (grupo ${groupId}) tenant ${tid}`);

    return { group_id: groupId, installments: n, total: totalCents / 100 };
  }
}
