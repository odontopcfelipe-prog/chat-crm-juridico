/**
 * Vínculos vindos do corpo só da própria conta — Financeiro, Estoque e Estética.
 *
 *  - lançamento (create/update): lead_id e dentist_id;
 *  - movimento de estoque: supplier_id e appointment_id;
 *  - produto (create/update): supplier_id;
 *  - aplicação estética: clinical_note_id, appointment_id, treatment_plan_item_id
 *    e applied_by_user_id.
 *
 * Id de outra conta ou de registro sem conta (tenant_id NULL) → "não encontrado"
 * e nada é gravado. Conta própria → as mesmas gravações de hoje. Sem conta no
 * contexto (SUPER_ADMIN) → como hoje.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@crm/shared';
import { FinanceiroService } from './financeiro.service';
import { StockMovementsService } from '../inventory/stock-movements.service';
import { ProductsService } from '../inventory/products.service';
import { EstheticApplicationsService } from '../esthetic/esthetic-applications.service';

const A = 'tenant-a';
const B = 'tenant-b';

// "Banco" mínimo: cada registro com a conta dona (null = legado sem conta).
const LEADS = [
  { id: 'lead-a', tenant_id: A },
  { id: 'lead-b', tenant_id: B },
  { id: 'lead-null', tenant_id: null },
];
const USERS = [
  { id: 'dent-a', tenant_id: A },
  { id: 'dent-b', tenant_id: B },
  { id: 'user-null', tenant_id: null },
];
const SUPPLIERS = [
  { id: 'sup-a', tenant_id: A },
  { id: 'sup-b', tenant_id: B },
];
// Atendimento (evento da agenda): o antigo sem conta vale a conta de quem o criou.
const EVENTS = [
  { id: 'ev-a', tenant_id: A, criador: A },
  { id: 'ev-b', tenant_id: B, criador: B },
  { id: 'ev-null', tenant_id: null, criador: B }, // sem conta, criado por usuário de outra conta
  { id: 'ev-null-sem-dono', tenant_id: null, criador: null }, // sem conta, criado por usuário sem conta
  { id: 'ev-null-da-a', tenant_id: null, criador: A }, // sem conta, criado por usuário da A
];
/** Where da conta do evento (calendar/conta-do-evento) para a conta A. */
const EVENTOS_DA_A = {
  OR: [
    { tenant_id: A },
    { tenant_id: null, created_by: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead_id: null, patient: { tenant_id: A } },
    { tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: null }, patient: { tenant_id: A } },
  ],
};
// Nota clínica e item do plano não têm tenant_id: a conta vem pelo paciente.
const NOTES = [
  { id: 'note-a', patient_tenant: A },
  { id: 'note-b', patient_tenant: B },
];
const ITEMS = [
  { id: 'item-a', patient_tenant: A },
  { id: 'item-b', patient_tenant: B },
];

/** findFirst com o where de hoje do Prisma: tenant_id ausente = sem filtro; NULL nunca casa com conta. */
function achar(rows: { id: string; tenant_id: string | null }[]) {
  return jest.fn(async ({ where }: any) => {
    const r = rows.find(
      (x) => x.id === where.id && (where.tenant_id === undefined || x.tenant_id === where.tenant_id),
    );
    return r ? { id: r.id } : null;
  });
}

/**
 * Devolve só o que a consulta pediu, como o Prisma: `select` lista os campos (e as
 * relações com o próprio select); `include` soma relações aos campos simples; sem
 * os dois, só os campos simples. Assim um campo que sair do select some aqui também.
 */
const ehRelacao = (v: any) =>
  v !== null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);
function projetar(row: any, args: { select?: any; include?: any } = {}): any {
  if (row == null) return row;
  if (Array.isArray(row)) return row.map((r) => projetar(r, args));
  const out: any = {};
  if (args.select) {
    for (const [k, pedido] of Object.entries<any>(args.select)) {
      if (!pedido || !(k in row)) continue;
      out[k] = pedido === true ? (ehRelacao(row[k]) ? projetar(row[k]) : row[k]) : projetar(row[k], pedido);
    }
    return out;
  }
  for (const [k, v] of Object.entries(row)) if (!ehRelacao(v)) out[k] = v;
  for (const [k, pedido] of Object.entries<any>(args.include ?? {})) {
    if (!pedido || !(k in row)) continue;
    out[k] = pedido === true ? projetar(row[k]) : projetar(row[k], pedido);
  }
  return out;
}

/** findFirst do atendimento: entende o OR da conta do evento (gravada, ou a de quem o criou). */
function acharEvento(
  rows: { id: string; tenant_id: string | null; criador: string | null; contato?: string | null; paciente?: string | null }[],
) {
  // contato/paciente: conta do contato e do paciente ligados (undefined = sem o vínculo).
  const casa = (x: (typeof rows)[number], c: any) =>
    x.tenant_id === c.tenant_id &&
    (c.created_by === undefined || x.criador === c.created_by.tenant_id) &&
    (c.lead === undefined || (x.contato !== undefined && x.contato === c.lead.tenant_id)) &&
    (c.lead_id === undefined || (c.lead_id === null ? x.contato === undefined : true)) &&
    (c.patient === undefined || (x.paciente !== undefined && x.paciente === c.patient.tenant_id));
  return jest.fn(async ({ where }: any) => {
    const r = rows.find(
      (x) =>
        x.id === where.id &&
        (where.OR ? where.OR.some((c: any) => casa(x, c)) : where.tenant_id === undefined || x.tenant_id === where.tenant_id),
    );
    return r ? { id: r.id } : null;
  });
}

function acharPeloPaciente(rows: { id: string; patient_tenant: string }[], caminho: (w: any) => string | undefined) {
  return jest.fn(async ({ where }: any) => {
    const t = caminho(where);
    const r = rows.find((x) => x.id === where.id && x.patient_tenant === t);
    return r ? { id: r.id } : null;
  });
}

// ─── Financeiro ─────────────────────────────────────────────

describe('FinanceiroService — cliente e profissional do lançamento só da própria conta', () => {
  const TX_A = {
    id: 'tx-a',
    tenant_id: A,
    source: null,
    type: 'RECEITA',
    amount: 100,
    description: 'Consulta',
    status: 'PENDENTE',
    payment_method: null,
  };
  const TX_B = { ...TX_A, id: 'tx-b', tenant_id: B };

  function montar() {
    const escritas: string[] = [];
    const prisma: any = {
      lead: { findFirst: achar(LEADS) },
      user: { findFirst: achar(USERS) },
      financialTransaction: {
        findUnique: jest.fn(async ({ where }: any) => [TX_A, TX_B].find((t) => t.id === where.id) ?? null),
        create: jest.fn(async ({ data }: any) => {
          escritas.push('financialTransaction.create');
          return { id: 'tx-novo', ...data };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          escritas.push('financialTransaction.update');
          return { ...TX_A, id: where.id, ...data };
        }),
      },
      auditLog: {
        create: jest.fn(async () => {
          escritas.push('auditLog.create');
          return {};
        }),
      },
      leadHonorarioPayment: { findUnique: jest.fn() },
    };
    const moduleRef = { get: jest.fn() };
    const svc = new FinanceiroService(prisma, moduleRef as any);
    return { svc, prisma, moduleRef, escritas };
  }

  // Corpo exato da "Nova Receita" do web (contas-a-pagar/page.tsx) — sem lead nem dentista.
  const NOVA_RECEITA = {
    type: 'RECEITA',
    description: 'Clareamento',
    category: 'Procedimento',
    amount: 350,
    date: '2026-10-27T12:00:00.000Z',
    status: 'PAGO',
    payment_method: 'PIX',
    paid_at: '2026-10-27T15:00:00.000Z',
  };

  describe('createTransaction', () => {
    it.each([
      ['lead de outra conta', { lead_id: 'lead-b' }],
      ['lead sem conta (legado)', { lead_id: 'lead-null' }],
      ['profissional de outra conta', { dentist_id: 'dent-b' }],
      ['profissional sem conta', { dentist_id: 'user-null' }],
      ['lead que não existe', { lead_id: 'lead-x' }],
    ])('%s → 404 e nada é gravado', async (_n, vinculo) => {
      const m = montar();
      await expect(
        m.svc.createTransaction({ ...NOVA_RECEITA, ...vinculo, tenant_id: A, actor_id: 'u-a' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(m.prisma.financialTransaction.create).not.toHaveBeenCalled();
      expect(m.escritas).toEqual([]);
      // RECEITA PAGO com lead alheio não chega à promoção do contato
      expect(m.moduleRef.get).not.toHaveBeenCalled();
    });

    it('lead e profissional da própria conta → confere na conta e grava os mesmos campos de hoje', async () => {
      const m = montar();
      const body = {
        type: 'DESPESA',
        category: 'Laboratorio',
        description: 'Prótese',
        amount: 80,
        date: '2026-10-20T12:00:00.000Z',
        status: 'PENDENTE',
        lead_id: 'lead-a',
        dentist_id: 'dent-a',
        notes: 'obs',
      };
      await m.svc.createTransaction({ ...body, tenant_id: A, actor_id: 'u-a' } as any);

      expect(m.prisma.lead.findFirst).toHaveBeenCalledWith({ where: { id: 'lead-a', tenant_id: A }, select: { id: true } });
      expect(m.prisma.user.findFirst).toHaveBeenCalledWith({ where: { id: 'dent-a', tenant_id: A }, select: { id: true } });
      expect(m.prisma.financialTransaction.create).toHaveBeenCalledTimes(1);
      expect(m.prisma.financialTransaction.create.mock.calls[0][0]).toEqual({
        data: {
          tenant_id: A,
          source: null,
          company_id: null,
          is_variable_amount: null,
          type: 'DESPESA',
          category: 'Laboratorio',
          description: 'Prótese',
          amount: 80,
          date: new Date('2026-10-20T12:00:00.000Z'),
          due_date: null,
          paid_at: null,
          payment_method: undefined,
          status: 'PENDENTE',
          lead_id: 'lead-a',
          dentist_id: 'dent-a',
          reference_id: undefined,
          notes: 'obs',
          visible_to_dentist: true,
          is_recurring: false,
          recurrence_pattern: null,
          recurrence_day: null,
          recurrence_end_date: null,
        },
        include: {
          lead: { select: { id: true, name: true } },
          dentist: { select: { id: true, name: true } },
        },
      });
      expect(m.escritas).toEqual(['financialTransaction.create', 'auditLog.create']);
    });

    it('corpo da Nova Receita (sem lead/dentista) → nenhuma consulta extra, mesmo create', async () => {
      const m = montar();
      await m.svc.createTransaction({ ...NOVA_RECEITA, tenant_id: A, actor_id: 'u-a' } as any);

      expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.user.findFirst).not.toHaveBeenCalled();
      const data = m.prisma.financialTransaction.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        tenant_id: A,
        type: 'RECEITA',
        status: 'PAGO',
        amount: 350,
        payment_method: 'PIX',
        paid_at: new Date('2026-10-27T15:00:00.000Z'),
      });
      expect(data.lead_id).toBeUndefined();
      expect(data.dentist_id).toBeUndefined();
      expect(m.moduleRef.get).not.toHaveBeenCalled();
      expect(m.escritas).toEqual(['financialTransaction.create', 'auditLog.create']);
    });

    it('SUPER_ADMIN sem conta → como hoje (sem consulta, grava o que veio)', async () => {
      const m = montar();
      await m.svc.createTransaction({ ...NOVA_RECEITA, status: 'PENDENTE', lead_id: 'lead-b', dentist_id: 'dent-b', tenant_id: undefined } as any);

      expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.user.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.financialTransaction.create.mock.calls[0][0].data).toMatchObject({
        tenant_id: undefined,
        lead_id: 'lead-b',
        dentist_id: 'dent-b',
      });
    });
  });

  describe('updateTransaction', () => {
    it.each([
      ['lead de outra conta', { lead_id: 'lead-b' }],
      ['lead sem conta (legado)', { lead_id: 'lead-null' }],
      ['profissional de outra conta', { dentist_id: 'dent-b' }],
      ['profissional sem conta', { dentist_id: 'user-null' }],
    ])('%s → 404 e nada é gravado', async (_n, vinculo) => {
      const m = montar();
      await expect(m.svc.updateTransaction('tx-a', vinculo as any, A, 'u-a', 'PAYABLES')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(m.prisma.financialTransaction.update).not.toHaveBeenCalled();
      expect(m.escritas).toEqual([]);
    });

    it('lead/profissional vazio ou null continua limpando o vínculo, sem consulta', async () => {
      const m = montar();
      await m.svc.updateTransaction('tx-a', { lead_id: null, dentist_id: '' } as any, A, 'u-a', 'PAYABLES');

      expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.user.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.financialTransaction.update.mock.calls[0][0]).toEqual({
        where: { id: 'tx-a' },
        data: { lead_id: null, dentist_id: '' },
        include: {
          lead: { select: { id: true, name: true } },
          dentist: { select: { id: true, name: true } },
        },
      });
    });

    it('lead e profissional da própria conta → mesmo update de hoje', async () => {
      const m = montar();
      await m.svc.updateTransaction('tx-a', { lead_id: 'lead-a', dentist_id: 'dent-a', notes: 'x' } as any, A, 'u-a', 'PAYABLES');

      expect(m.prisma.financialTransaction.update.mock.calls[0][0].data).toEqual({
        lead_id: 'lead-a',
        dentist_id: 'dent-a',
        notes: 'x',
      });
      expect(m.escritas).toEqual(['financialTransaction.update', 'auditLog.create']);
    });

    it('edição sem lead/dentista (ex.: Contas a Pagar) → nenhuma consulta extra', async () => {
      const m = montar();
      await m.svc.updateTransaction('tx-a', { amount: 120, description: 'Aluguel' } as any, A, 'u-a');
      expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.user.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.financialTransaction.update.mock.calls[0][0].data).toEqual({ amount: 120, description: 'Aluguel' });
    });

    it('lançamento de outra conta → 403 como hoje, antes de conferir vínculos', async () => {
      const m = montar();
      await expect(m.svc.updateTransaction('tx-b', { lead_id: 'lead-a' } as any, A, 'u-a')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(m.escritas).toEqual([]);
    });

    it('SUPER_ADMIN sem conta → como hoje', async () => {
      const m = montar();
      await m.svc.updateTransaction('tx-a', { lead_id: 'lead-b' } as any, undefined, 'root');
      expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.financialTransaction.update.mock.calls[0][0].data).toEqual({ lead_id: 'lead-b' });
    });
  });

  describe('createFromLeadHonorarioPayment — não nasce lançamento sem conta', () => {
    function pagamento(honorarioTenant: string | null) {
      return {
        id: 'pg-1',
        status: 'PAGO',
        amount: 500,
        paid_at: new Date('2026-10-01T12:00:00.000Z'),
        due_date: null,
        payment_method: 'PIX',
        notes: null,
        lead_honorario: {
          tenant_id: honorarioTenant,
          type: 'ENTRADA',
          notes: null,
          lead: { id: 'lead-a', name: 'Fulano', tenant_id: A },
        },
      };
    }

    // A leitura do pagamento devolve só o que o include/select pediu (como o Prisma):
    // a conta do contato só chega ao service se o select do lead pedir tenant_id.
    function lerPagamento(m: ReturnType<typeof montar>, honorarioTenant: string | null) {
      m.prisma.leadHonorarioPayment.findUnique.mockImplementation(async (a: any) => projetar(pagamento(honorarioTenant), a));
      m.prisma.financialTransaction.findUnique.mockResolvedValue(null);
    }

    it('honorário sem conta → herda a conta do contato', async () => {
      const m = montar();
      lerPagamento(m, null);
      await m.svc.createFromLeadHonorarioPayment('pg-1', undefined);
      expect(m.prisma.financialTransaction.create.mock.calls[0][0].data.tenant_id).toBe(A);
      expect(m.prisma.financialTransaction.create.mock.calls[0][0].data.lead_id).toBe('lead-a');
      // A conta do contato vem do select do lead.
      const leitura = m.prisma.leadHonorarioPayment.findUnique.mock.calls[0][0];
      expect(leitura.where).toEqual({ id: 'pg-1' });
      expect(leitura.include.lead_honorario.include.lead.select).toEqual({ id: true, name: true, tenant_id: true });
    });

    it('sem tenant_id no select do lead, o lançamento nasceria sem conta (o mock não entrega o que não foi pedido)', async () => {
      const m = montar();
      m.prisma.leadHonorarioPayment.findUnique.mockImplementation(async (a: any) => {
        const { tenant_id: _conta, ...resto } = a.include.lead_honorario.include.lead.select;
        const semConta = {
          ...a,
          include: { lead_honorario: { include: { lead: { select: resto } } } },
        };
        return projetar(pagamento(null), semConta);
      });
      m.prisma.financialTransaction.findUnique.mockResolvedValue(null);
      await m.svc.createFromLeadHonorarioPayment('pg-1', undefined);
      // É isso que o teste anterior pega se o campo sair do select do service.
      expect(m.prisma.financialTransaction.create.mock.calls[0][0].data.tenant_id).toBeNull();
    });

    it('conta informada → continua sendo a usada', async () => {
      const m = montar();
      lerPagamento(m, A);
      await m.svc.createFromLeadHonorarioPayment('pg-1', A);
      expect(m.prisma.financialTransaction.create.mock.calls[0][0].data.tenant_id).toBe(A);
    });
  });
});

// ─── Estoque: movimento ─────────────────────────────────────

describe('StockMovementsService.create — fornecedor e atendimento só da própria conta', () => {
  const PRODUTO_A = {
    id: 'prod-a',
    tenant_id: A,
    name: 'Resina',
    current_stock: new Prisma.Decimal(10),
    requires_lot_tracking: false,
    has_expiration: false,
  };

  function montar() {
    const escritas: string[] = [];
    const tx: any = {
      stockMovement: {
        create: jest.fn(async ({ data }: any) => {
          escritas.push('stockMovement.create');
          return { id: 'mov-1', ...data };
        }),
      },
      product: {
        update: jest.fn(async () => {
          escritas.push('product.update');
          return { current_stock: new Prisma.Decimal(15) };
        }),
      },
    };
    const prisma: any = {
      product: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === PRODUTO_A.id && where.tenant_id === A ? PRODUTO_A : null,
        ),
      },
      supplier: { findFirst: achar(SUPPLIERS) },
      calendarEvent: { findFirst: acharEvento(EVENTS) },
      globalSetting: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: any) => {
        escritas.push('$transaction');
        return fn(tx);
      }),
    };
    return { svc: new StockMovementsService(prisma), prisma, tx, escritas };
  }

  // Corpo exato da tela de Estoque (MovementsTab.tsx) — sem fornecedor nem atendimento.
  const MOVIMENTO_TELA = {
    product_id: 'prod-a',
    type: 'ENTRADA',
    quantity: 5,
    unit_cost: 2.5,
    batch_number: 'L1',
    notes: 'reposição',
  };

  it.each([
    ['fornecedor de outra conta', { supplier_id: 'sup-b' }],
    ['atendimento de outra conta', { appointment_id: 'ev-b' }],
    ['atendimento sem conta criado por outra conta', { appointment_id: 'ev-null' }],
    ['atendimento sem conta criado por usuário sem conta', { appointment_id: 'ev-null-sem-dono' }],
  ])('%s → 404 e o saldo não é tocado', async (_n, vinculo) => {
    const m = montar();
    await expect(m.svc.create(A, 'u-a', { ...MOVIMENTO_TELA, ...vinculo } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.escritas).toEqual([]);
  });

  it('fornecedor e atendimento da própria conta → grava igual a hoje', async () => {
    const m = montar();
    await m.svc.create(A, 'u-a', { ...MOVIMENTO_TELA, supplier_id: 'sup-a', appointment_id: 'ev-a' } as any);

    expect(m.prisma.supplier.findFirst).toHaveBeenCalledWith({ where: { id: 'sup-a', tenant_id: A }, select: { id: true } });
    expect(m.prisma.calendarEvent.findFirst).toHaveBeenCalledWith({ where: { id: 'ev-a', ...EVENTOS_DA_A }, select: { id: true } });
    expect(m.tx.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: A,
      product_id: 'prod-a',
      supplier_id: 'sup-a',
      appointment_id: 'ev-a',
    });
    expect(m.escritas).toEqual(['$transaction', 'stockMovement.create', 'product.update']);
  });

  it('atendimento antigo sem conta criado por usuário da conta → aceito, grava igual a hoje', async () => {
    const m = montar();
    await m.svc.create(A, 'u-a', { ...MOVIMENTO_TELA, appointment_id: 'ev-null-da-a' } as any);
    expect(m.tx.stockMovement.create.mock.calls[0][0].data).toMatchObject({ tenant_id: A, appointment_id: 'ev-null-da-a' });
    expect(m.escritas).toEqual(['$transaction', 'stockMovement.create', 'product.update']);
  });

  it('corpo da tela (sem os dois) → nenhuma consulta extra e o mesmo stockMovement.create', async () => {
    const m = montar();
    await m.svc.create(A, 'u-a', MOVIMENTO_TELA as any);

    expect(m.prisma.supplier.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.calendarEvent.findFirst).not.toHaveBeenCalled();
    expect(m.tx.stockMovement.create.mock.calls[0][0]).toEqual({
      data: {
        tenant_id: A,
        product_id: 'prod-a',
        supplier_id: undefined,
        type: 'ENTRADA',
        quantity: new Prisma.Decimal(5),
        unit_cost: new Prisma.Decimal(2.5),
        total_cost: undefined,
        batch_number: 'L1',
        expiration_date: undefined,
        appointment_id: undefined,
        notes: 'reposição',
        performed_by_user_id: 'u-a',
      },
    });
    expect(m.tx.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-a' },
      data: { current_stock: { increment: new Prisma.Decimal(5) } },
      select: { current_stock: true },
    });
  });

  it('sem conta no contexto → 400 como hoje, sem consulta', async () => {
    const m = montar();
    await expect(m.svc.create(undefined as any, 'root', { ...MOVIMENTO_TELA, supplier_id: 'sup-b' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(m.prisma.supplier.findFirst).not.toHaveBeenCalled();
    expect(m.escritas).toEqual([]);
  });
});

// ─── Estoque: produto ───────────────────────────────────────

describe('ProductsService — fornecedor do produto só da própria conta', () => {
  function montar() {
    const escritas: string[] = [];
    const prisma: any = {
      product: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === 'prod-a' && (where.tenant_id === undefined || where.tenant_id === A)
            ? { id: 'prod-a', tenant_id: A }
            : null,
        ),
        create: jest.fn(async ({ data }: any) => {
          escritas.push('product.create');
          return { id: 'prod-novo', ...data };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          escritas.push('product.update');
          return { id: where.id, ...data };
        }),
      },
      supplier: { findFirst: achar(SUPPLIERS) },
    };
    return { svc: new ProductsService(prisma), prisma, escritas };
  }

  const PRODUTO = { name: 'Luva', category: 'DESCARTAVEL', unit: 'CX', sku: 'LUV-1' };

  it('create com fornecedor de outra conta → 404 e nada é gravado', async () => {
    const m = montar();
    await expect(m.svc.create(A, { ...PRODUTO, supplier_id: 'sup-b' } as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.product.create).not.toHaveBeenCalled();
    expect(m.escritas).toEqual([]);
  });

  it('create com fornecedor da própria conta → mesmo create de hoje', async () => {
    const m = montar();
    await m.svc.create(A, { ...PRODUTO, supplier_id: 'sup-a' } as any);
    expect(m.prisma.supplier.findFirst).toHaveBeenCalledWith({ where: { id: 'sup-a', tenant_id: A }, select: { id: true } });
    expect(m.prisma.product.create).toHaveBeenCalledWith({ data: { ...PRODUTO, supplier_id: 'sup-a', tenant_id: A } });
  });

  it('create sem fornecedor → nenhuma consulta extra', async () => {
    const m = montar();
    await m.svc.create(A, PRODUTO as any);
    expect(m.prisma.supplier.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.product.create).toHaveBeenCalledWith({ data: { ...PRODUTO, tenant_id: A } });
  });

  it('update com fornecedor de outra conta → 404 e nada é gravado', async () => {
    const m = montar();
    await expect(m.svc.update('prod-a', A, { supplier_id: 'sup-b' } as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.product.update).not.toHaveBeenCalled();
    expect(m.escritas).toEqual([]);
  });

  it('update com fornecedor da própria conta → mesmo update de hoje', async () => {
    const m = montar();
    await m.svc.update('prod-a', A, { supplier_id: 'sup-a', min_stock: 3 } as any);
    expect(m.prisma.product.update).toHaveBeenCalledWith({ where: { id: 'prod-a' }, data: { supplier_id: 'sup-a', min_stock: 3 } });
  });

  it('update com supplier_id null continua limpando, sem consulta', async () => {
    const m = montar();
    await m.svc.update('prod-a', A, { supplier_id: null } as any);
    expect(m.prisma.supplier.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.product.update).toHaveBeenCalledWith({ where: { id: 'prod-a' }, data: { supplier_id: null } });
  });

  it('update sem conta no contexto → como hoje (sem conferir fornecedor)', async () => {
    const m = montar();
    await m.svc.update('prod-a', undefined as any, { supplier_id: 'sup-b' } as any);
    expect(m.prisma.supplier.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.product.update).toHaveBeenCalledWith({ where: { id: 'prod-a' }, data: { supplier_id: 'sup-b' } });
  });
});

// ─── Estética ───────────────────────────────────────────────

describe('EstheticApplicationsService.create — vínculos só da própria conta', () => {
  const PRODUTO_A = {
    id: 'prod-a',
    tenant_id: A,
    name: 'Toxina',
    brand: 'Marca',
    current_stock: new Prisma.Decimal(10),
    requires_lot_tracking: false,
  };

  function montar() {
    const escritas: string[] = [];
    const tx: any = {
      estheticApplication: {
        create: jest.fn(async ({ data }: any) => {
          escritas.push('estheticApplication.create');
          return { id: 'apl-1', ...data };
        }),
      },
      stockMovement: {
        create: jest.fn(async () => {
          escritas.push('stockMovement.create');
          return {};
        }),
      },
      product: {
        update: jest.fn(async () => {
          escritas.push('product.update');
          return {};
        }),
      },
    };
    const prisma: any = {
      patient: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === 'pac-a' && where.tenant_id === A ? { id: 'pac-a', tenant_id: A, name: 'Paciente A' } : null,
        ),
      },
      product: {
        findFirst: jest.fn(async ({ where }: any) => (where.id === 'prod-a' && where.tenant_id === A ? PRODUTO_A : null)),
      },
      procedure: { findFirst: jest.fn(async () => null) },
      clinicalNote: { findFirst: acharPeloPaciente(NOTES, (w) => w.medical_record?.patient?.tenant_id) },
      calendarEvent: { findFirst: acharEvento(EVENTS) },
      treatmentPlanItem: { findFirst: acharPeloPaciente(ITEMS, (w) => w.treatment_plan?.patient?.tenant_id) },
      user: { findFirst: achar(USERS) },
      $transaction: jest.fn(async (fn: any) => {
        escritas.push('$transaction');
        return fn(tx);
      }),
    };
    const maintenance = { createFromEstheticApplication: jest.fn() };
    const svc = new EstheticApplicationsService(prisma, maintenance as any);
    return { svc, prisma, tx, maintenance, escritas };
  }

  // Corpo exato da aba Estética Facial (EsteticaFacialTab.tsx) — sem nenhum dos quatro vínculos.
  const APLICACAO_TELA = {
    application_point: 'GLABELA',
    side: 'CENTRAL',
    product_id: 'prod-a',
    batch_number: 'LT-9',
    volume: 2,
    unit: 'UI',
    notes: 'ok',
    applied_at: '2026-10-27T13:00:00.000Z',
  };

  it.each([
    ['nota clínica de outra conta', { clinical_note_id: 'note-b' }],
    ['atendimento de outra conta', { appointment_id: 'ev-b' }],
    ['atendimento sem conta criado por outra conta', { appointment_id: 'ev-null' }],
    ['atendimento sem conta criado por usuário sem conta', { appointment_id: 'ev-null-sem-dono' }],
    ['item do plano de outra conta', { treatment_plan_item_id: 'item-b' }],
    ['profissional de outra conta', { applied_by_user_id: 'dent-b' }],
    ['profissional sem conta', { applied_by_user_id: 'user-null' }],
  ])('%s → 404, nada gravado e sem baixa de estoque', async (_n, vinculo) => {
    const m = montar();
    await expect(m.svc.create(A, 'pac-a', 'u-a', { ...APLICACAO_TELA, ...vinculo } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.maintenance.createFromEstheticApplication).not.toHaveBeenCalled();
    expect(m.escritas).toEqual([]);
  });

  it('vínculos da própria conta → confere pela conta e grava igual a hoje', async () => {
    const m = montar();
    await m.svc.create(A, 'pac-a', 'u-a', {
      ...APLICACAO_TELA,
      clinical_note_id: 'note-a',
      appointment_id: 'ev-a',
      treatment_plan_item_id: 'item-a',
      applied_by_user_id: 'dent-a',
    } as any);

    expect(m.prisma.clinicalNote.findFirst).toHaveBeenCalledWith({
      where: { id: 'note-a', medical_record: { patient: { tenant_id: A } } },
      select: { id: true },
    });
    expect(m.prisma.calendarEvent.findFirst).toHaveBeenCalledWith({ where: { id: 'ev-a', ...EVENTOS_DA_A }, select: { id: true } });
    expect(m.prisma.treatmentPlanItem.findFirst).toHaveBeenCalledWith({
      where: { id: 'item-a', treatment_plan: { patient: { tenant_id: A } } },
      select: { id: true },
    });
    expect(m.prisma.user.findFirst).toHaveBeenCalledWith({ where: { id: 'dent-a', tenant_id: A }, select: { id: true } });

    expect(m.tx.estheticApplication.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: A,
      patient_id: 'pac-a',
      clinical_note_id: 'note-a',
      appointment_id: 'ev-a',
      treatment_plan_item_id: 'item-a',
      applied_by_user_id: 'dent-a',
    });
    expect(m.tx.stockMovement.create.mock.calls[0][0].data).toMatchObject({ appointment_id: 'ev-a', performed_by_user_id: 'dent-a' });
    expect(m.escritas).toEqual(['$transaction', 'estheticApplication.create', 'stockMovement.create', 'product.update']);
  });

  it('atendimento antigo sem conta criado por usuário da conta → aceito, grava igual a hoje', async () => {
    const m = montar();
    await m.svc.create(A, 'pac-a', 'u-a', { ...APLICACAO_TELA, appointment_id: 'ev-null-da-a' } as any);
    expect(m.tx.estheticApplication.create.mock.calls[0][0].data).toMatchObject({ tenant_id: A, appointment_id: 'ev-null-da-a' });
    expect(m.escritas).toEqual(['$transaction', 'estheticApplication.create', 'stockMovement.create', 'product.update']);
  });

  it('corpo da tela (sem vínculos) → nenhuma consulta extra e o mesmo create', async () => {
    const m = montar();
    await m.svc.create(A, 'pac-a', 'u-a', APLICACAO_TELA as any);

    expect(m.prisma.clinicalNote.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.calendarEvent.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.treatmentPlanItem.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.user.findFirst).not.toHaveBeenCalled();
    expect(m.tx.estheticApplication.create.mock.calls[0][0]).toEqual({
      data: {
        tenant_id: A,
        patient_id: 'pac-a',
        procedure_id: undefined,
        clinical_note_id: undefined,
        appointment_id: undefined,
        treatment_plan_item_id: undefined,
        application_point: 'GLABELA',
        side: 'CENTRAL',
        product_id: 'prod-a',
        product_name_snapshot: 'Toxina',
        brand_snapshot: 'Marca',
        batch_number: 'LT-9',
        expiration_date: undefined,
        volume: new Prisma.Decimal(2),
        unit: 'UI',
        dilution: undefined,
        needle_gauge: undefined,
        technique: undefined,
        depth: undefined,
        notes: 'ok',
        expected_duration_months: null,
        expected_revisit_at: null,
        applied_by_user_id: 'u-a',
        applied_at: new Date('2026-10-27T13:00:00.000Z'),
      },
    });
    expect(m.escritas).toEqual(['$transaction', 'estheticApplication.create', 'stockMovement.create', 'product.update']);
  });

  it('sem conta no contexto → 400 como hoje, sem consulta', async () => {
    const m = montar();
    await expect(
      m.svc.create(undefined as any, 'pac-a', 'root', { ...APLICACAO_TELA, appointment_id: 'ev-b' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.prisma.calendarEvent.findFirst).not.toHaveBeenCalled();
    expect(m.escritas).toEqual([]);
  });
});
