/**
 * Fase 0 — Grupo 3: confirmação de procedimento (executeItem / executeItemAsActor),
 * comissão sem duplicar, finalizePlans só com dentista e gate do plano, PATCH de item.
 * Prisma mockado; $transaction = (fn) => fn(prisma).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TreatmentPlansService } from './treatment-plans.service';
import { MSG_AGUARDANDO_FINANCEIRO, MSG_ITEM_OUTRO_DENTISTA, MSG_PLANO_CANCELADO, MSG_SO_DENTISTA } from './execucao-regras';

const TENANT = 't1';
const POS_CORTE = new Date('2026-10-20T12:00:00.000Z');
const PRE_CORTE = new Date('2026-10-01T12:00:00.000Z');
const VALIDADO = new Date('2026-10-20T13:00:00.000Z');

type Plano = { id: string; status: string; created_at: Date; validated_by_financial_at: Date | null; patient_id: string };

function montar(opts: {
  item?: Partial<{ id: string; status: string; dentist_id: string | null; notes: string | null }>;
  plano?: Partial<Plano>;
  dentistasNoBanco?: string[];           // ids com papel DENTIST no tenant
  eventosDoTenant?: string[];             // calendarEvent ids desta clínica
  claimCount?: number;                    // resultado do updateMany do claim
  comissaoExistente?: { id: string } | null;
} = {}) {
  const plano: Plano = {
    id: 'plan1',
    status: 'ACTIVE',
    created_at: POS_CORTE,
    validated_by_financial_at: VALIDADO,
    patient_id: 'pat1',
    ...opts.plano,
  };
  const item = {
    id: 'item1',
    status: 'PENDING',
    dentist_id: 'dent1' as string | null,
    notes: null as string | null,
    procedure_id: 'proc1',
    quantity: 1,
    unit_price: 100,
    ...opts.item,
    treatment_plan: { ...plano, patient: { tenant_id: TENANT } },
  };
  const dentistas = new Set(opts.dentistasNoBanco ?? ['dent1', 'dent2']);
  const eventos = new Set(opts.eventosDoTenant ?? ['ev1']);

  const prisma: any = {
    treatmentPlanItem: {
      findUnique: jest.fn(async (args: any) => {
        if (args?.include?.procedure) {
          // releitura pós-claim (shape do retorno)
          return {
            ...item,
            id: args.where.id,
            status: 'DONE',
            executed_at: new Date(),
            executed_by_user_id: 'x',
            procedure: { id: 'proc1', name: 'Restauração', category: 'DENTISTICA', commissionable: true },
            treatment_plan: { id: plano.id, patient_id: plano.patient_id, quote_id: 'q1' },
          };
        }
        return { ...item, id: args.where.id };
      }),
      updateMany: jest.fn(async () => ({ count: opts.claimCount ?? 1 })),
      update: jest.fn(async (args: any) => ({ ...item, ...args.data })),
      count: jest.fn(async () => 0),
    },
    user: {
      count: jest.fn(async (args: any) => {
        const w = args.where;
        if (w.id?.in) {
          // finalizePlans: quantos executores são dentistas da clínica
          return (w.id.in as string[]).filter((id) => dentistas.has(id)).length;
        }
        return dentistas.has(w.id) ? 1 : 0;
      }),
      findUnique: jest.fn(async (args: any) => {
        if (args?.select?.commission_exec_type) return { commission_exec_type: 'PERCENT', commission_exec_value: 10 };
        return { name: 'Admin' };
      }),
    },
    calendarEvent: {
      findFirst: jest.fn(async (args: any) =>
        args.where.tenant_id === TENANT && eventos.has(args.where.id) ? { id: args.where.id } : null),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    commissionRule: { findMany: jest.fn(async () => []) },
    paymentGatewayCharge: { findFirst: jest.fn(async () => null) },
    commission: {
      findFirst: jest.fn(async () => opts.comissaoExistente ?? null),
      create: jest.fn(async () => ({ id: 'com1' })),
    },
    treatmentPlan: {
      findUnique: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
    },
  };
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));
  const svc = new TreatmentPlansService(prisma, {} as any);
  return { svc, prisma, item, plano };
}

const ADMIN = { id: 'adm1', roles: ['ADMIN'] };
const DENT1 = { id: 'dent1', roles: ['DENTIST'] };
const DENT2 = { id: 'dent2', roles: ['DENTIST'] };
const CRC = { id: 'crc1', roles: ['COMERCIAL'] };

async function erro(p: Promise<any>): Promise<any> {
  return p.then(() => { throw new Error('esperava erro'); }, (e) => e);
}

describe('TreatmentPlansService — execução (Fase 0, Grupo 3)', () => {
  it('1. dentista do item executa: claim + auditoria + comissão', async () => {
    const { svc, prisma } = montar();
    const r = await svc.executeItemAsActor('item1', TENANT, DENT1, {});
    expect(r?.status).toBe('DONE');
    expect(prisma.treatmentPlanItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'item1', status: { notIn: ['DONE', 'CANCELLED'] } },
      data: expect.objectContaining({ status: 'DONE', executed_by_user_id: 'dent1' }),
    }));
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ tenant_id: TENANT, actor_user_id: 'dent1', entity: 'TREATMENT_PLAN_ITEM', entity_id: 'item1', action: 'EXECUTADO' });
    expect(audit.meta_json).toMatchObject({ via: 'execute', plan_id: 'plan1', patient_id: 'pat1', before: { status: 'PENDING' } });
    expect(prisma.commission.create).toHaveBeenCalledTimes(1);
  });

  it('2. outro dentista leva 403 PERMISSION_DENIED e nada é gravado', async () => {
    const { svc, prisma } = montar();
    const e = await erro(svc.executeItemAsActor('item1', TENANT, DENT2, {}));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', message: MSG_ITEM_OUTRO_DENTISTA });
    expect(prisma.treatmentPlanItem.updateMany).not.toHaveBeenCalled();
  });

  it('3. item sem dentista: ator DENTIST (no banco) passa; não dentista leva 403', async () => {
    const ok = montar({ item: { dentist_id: null } });
    await ok.svc.executeItemAsActor('item1', TENANT, DENT2, {});
    expect(ok.prisma.treatmentPlanItem.updateMany).toHaveBeenCalled();
    expect(ok.prisma.user.count).toHaveBeenCalledWith({ where: { id: 'dent2', tenant_id: TENANT, roles: { has: 'DENTIST' } } });

    const neg = montar({ item: { dentist_id: null } });
    const e = await erro(neg.svc.executeItemAsActor('item1', TENANT, CRC, {}));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', message: MSG_SO_DENTISTA });
    expect(neg.prisma.treatmentPlanItem.updateMany).not.toHaveBeenCalled();
  });

  it('3c. CRC que se pôs como dentista do item (dentist_id = ele) leva 403 — não é dentista no banco', async () => {
    const { svc, prisma } = montar({ item: { dentist_id: 'crc1' } });
    const e = await erro(svc.executeItemAsActor('item1', TENANT, CRC, {}));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', message: MSG_SO_DENTISTA });
    expect(prisma.treatmentPlanItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.commission.create).not.toHaveBeenCalled();
  });

  it('3b. JWT diz DENTIST mas o banco não: item sem dentista leva 403', async () => {
    const { svc } = montar({ item: { dentist_id: null }, dentistasNoBanco: [] });
    const e = await erro(svc.executeItemAsActor('item1', TENANT, { id: 'ex', roles: ['DENTIST'] }, {}));
    expect(e).toBeInstanceOf(ForbiddenException);
  });

  it('4. ADMIN passa em item de outro dentista, sem consultar o papel no banco', async () => {
    const { svc, prisma } = montar();
    await svc.executeItemAsActor('item1', TENANT, ADMIN, {});
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.treatmentPlanItem.updateMany).toHaveBeenCalled();
    expect(prisma.auditLog.create.mock.calls[0][0].data.actor_user_id).toBe('adm1');
  });

  it('5. plano pós-corte sem validação do Financeiro: 400 (inclusive ADMIN); pré-corte passa', async () => {
    const pos = montar({ plano: { created_at: POS_CORTE, validated_by_financial_at: null } });
    const e = await erro(pos.svc.executeItemAsActor('item1', TENANT, ADMIN, {}));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(MSG_AGUARDANDO_FINANCEIRO);
    expect(pos.prisma.treatmentPlanItem.updateMany).not.toHaveBeenCalled();

    const pre = montar({ plano: { created_at: PRE_CORTE, validated_by_financial_at: null } });
    await pre.svc.executeItemAsActor('item1', TENANT, DENT1, {});
    expect(pre.prisma.treatmentPlanItem.updateMany).toHaveBeenCalled();
  });

  it('6. plano CANCELLED: 400', async () => {
    const { svc, prisma } = montar({ plano: { status: 'CANCELLED' } });
    const e = await erro(svc.executeItemAsActor('item1', TENANT, ADMIN, {}));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(MSG_PLANO_CANCELADO);
    expect(prisma.treatmentPlanItem.updateMany).not.toHaveBeenCalled();
  });

  it('7. corrida (claim com count 0): 400 "Item ja foi executado" e sem comissão', async () => {
    const { svc, prisma } = montar({ claimCount: 0 });
    const e = await erro(svc.executeItemAsActor('item1', TENANT, DENT1, {}));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('Item ja foi executado');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.commission.create).not.toHaveBeenCalled();
  });

  it('8. comissão EXECUCAO viva já existe: não cria outra', async () => {
    const { svc, prisma } = montar({ comissaoExistente: { id: 'com-antiga' } });
    await svc.executeItemAsActor('item1', TENANT, DENT1, {});
    expect(prisma.commission.findFirst).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, treatment_plan_item_id: 'item1', kind: 'EXECUCAO', status: { not: 'CANCELADA' } },
      select: { id: true },
    });
    expect(prisma.commission.create).not.toHaveBeenCalled();
  });

  it('9. appointment_id de outra clínica: 400 e nada é gravado', async () => {
    const { svc, prisma } = montar({ eventosDoTenant: [] });
    const e = await erro(svc.executeItemAsActor('item1', TENANT, DENT1, { appointment_id: 'ev-de-outra' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('Agendamento informado não é desta clínica.');
    expect(prisma.treatmentPlanItem.updateMany).not.toHaveBeenCalled();
  });

  it('9b. appointment_id desta clínica: liga o agendamento ao item', async () => {
    const { svc, prisma } = montar();
    await svc.executeItemAsActor('item1', TENANT, DENT1, { appointment_id: 'ev1' });
    expect(prisma.treatmentPlanItem.updateMany.mock.calls[0][0].data.scheduled_appointment_id).toBe('ev1');
  });

  it('item já DONE ou CANCELLED continua barrado antes de tudo', async () => {
    const done = montar({ item: { status: 'DONE' } });
    expect((await erro(done.svc.executeItemAsActor('item1', TENANT, ADMIN, {}))).message).toBe('Item ja foi executado');
    const canc = montar({ item: { status: 'CANCELLED' } });
    expect((await erro(canc.svc.executeItemAsActor('item1', TENANT, ADMIN, {}))).message).toBe('Item cancelado nao pode ser executado');
  });
});

describe('TreatmentPlansService.finalizePlans — Fase 0 (F4)', () => {
  function planoCompleto(over: Partial<Plano> = {}) {
    return {
      id: 'plan1',
      status: 'ACTIVE',
      created_at: POS_CORTE,
      validated_by_financial_at: VALIDADO,
      patient_id: 'pat1',
      patient: { id: 'pat1', name: 'Paciente', tenant_id: TENANT },
      quote: { id: 'q1', title: 'Restaurações' },
      items: [
        { id: 'item1', status: 'PENDING', notes: null },
        { id: 'item2', status: 'PENDING', notes: null },
      ],
      ...over,
    };
  }

  it('executor que não é dentista da clínica: 400 e nada é gravado', async () => {
    const { svc, prisma } = montar({ dentistasNoBanco: ['dent1'] });
    prisma.treatmentPlan.findUnique.mockResolvedValue(planoCompleto());
    const e = await erro(svc.finalizePlans(TENANT, 'adm1', ['plan1'], [
      { item_id: 'item1', executed_by_user_id: 'dent1' },
      { item_id: 'item2', executed_by_user_id: 'crc1' },
    ]));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('Responsável inválido — tem que ser um dentista desta clínica.');
    expect(prisma.user.count.mock.calls[0][0].where.OR).toEqual([
      { roles: { has: 'DENTIST' } },
      { roles: { has: 'ADMIN' }, specialties: { isEmpty: false } },
    ]);
    expect(prisma.treatmentPlanItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.treatmentPlanItem.update).not.toHaveBeenCalled();
  });

  it('plano pós-corte sem validação: 400 antes de qualquer update (nem o "não realizado")', async () => {
    const { svc, prisma } = montar();
    prisma.treatmentPlan.findUnique.mockResolvedValue(planoCompleto({ validated_by_financial_at: null }));
    const e = await erro(svc.finalizePlans(TENANT, 'adm1', ['plan1'], [
      { item_id: 'item1', not_done: true },
      { item_id: 'item2', executed_by_user_id: 'dent1' },
    ]));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toContain(MSG_AGUARDANDO_FINANCEIRO);
    expect(prisma.treatmentPlanItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.treatmentPlanItem.update).not.toHaveBeenCalled();
    expect(prisma.treatmentPlan.update).not.toHaveBeenCalled();
  });

  it('plano pós-corte sem validação, mas tudo "não realizado": não é barrado', async () => {
    const { svc, prisma } = montar();
    const plano = planoCompleto({ validated_by_financial_at: null });
    prisma.treatmentPlan.findUnique
      .mockResolvedValueOnce(plano) // checagem de tenant
      .mockResolvedValue({ ...plano, items: plano.items.map((i) => ({ ...i, status: 'CANCELLED' })) }); // complete()
    const r = await svc.finalizePlans(TENANT, 'adm1', ['plan1'], [
      { item_id: 'item1', not_done: true },
      { item_id: 'item2', not_done: true },
    ]);
    expect(r).toEqual({ done: 0, not_done: 2, completed: 1 });
    expect(prisma.treatmentPlanItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'item1', status: { notIn: ['DONE', 'CANCELLED'] } },
    }));
  });

  it('caminho feliz: executa via núcleo (via finalize, ator = ADMIN) e audita as decisões', async () => {
    const { svc, prisma } = montar();
    const plano = planoCompleto();
    prisma.treatmentPlan.findUnique
      .mockResolvedValueOnce(plano)
      .mockResolvedValue({ ...plano, items: plano.items.map((i) => ({ ...i, status: 'DONE' })) });
    const execs = [
      { item_id: 'item1', executed_by_user_id: 'dent1' },
      { item_id: 'item2', executed_by_user_id: 'dent2' },
    ];
    const r = await svc.finalizePlans(TENANT, 'adm1', ['plan1'], execs);
    expect(r).toEqual({ done: 2, not_done: 0, completed: 1 });
    const audits = prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
    const exec = audits.filter((a: any) => a.action === 'EXECUTADO');
    expect(exec).toHaveLength(2);
    expect(exec[0]).toMatchObject({ actor_user_id: 'adm1', tenant_id: TENANT });
    expect(exec[0].meta_json.via).toBe('finalize');
    const fin = audits.find((a: any) => a.entity === 'TREATMENT_FINALIZE');
    expect(fin).toMatchObject({ tenant_id: TENANT, actor_user_id: 'adm1', action: 'finalize' });
    expect(fin.meta_json.decisoes).toEqual(execs);
  });
});

describe('TreatmentPlansService.updateItem — Fase 0 (F5)', () => {
  it('status vindo de não-admin: 403 PERMISSION_DENIED', async () => {
    const { svc, prisma } = montar();
    const e = await erro(svc.updateItem('item1', TENANT, { status: 'CANCELLED' }, DENT1));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse().code).toBe('PERMISSION_DENIED');
    expect(prisma.treatmentPlanItem.update).not.toHaveBeenCalled();
  });

  it('DONE vindo de ADMIN: 400 (concluir só pelo Confirmar/Validar)', async () => {
    const { svc, prisma } = montar();
    const e = await erro(svc.updateItem('item1', TENANT, { status: 'DONE' }, ADMIN));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(prisma.treatmentPlanItem.update).not.toHaveBeenCalled();
  });

  it('ADMIN muda status (não DONE): grava e audita', async () => {
    const { svc, prisma } = montar({ item: { status: 'DONE' } });
    await svc.updateItem('item1', TENANT, { status: 'PENDING' }, ADMIN);
    expect(prisma.treatmentPlanItem.update).toHaveBeenCalled();
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: TENANT, actor_user_id: 'adm1', entity: 'TREATMENT_PLAN_ITEM', action: 'STATUS',
      meta_json: { before: { status: 'DONE' }, after: { status: 'PENDING' } },
    });
  });

  it('não-admin mexendo só em notas/ordem (ou mandando o mesmo status) continua podendo', async () => {
    const { svc, prisma } = montar();
    await svc.updateItem('item1', TENANT, { notes: 'obs', order_index: 2, status: 'PENDING' }, DENT1);
    expect(prisma.treatmentPlanItem.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('scheduled_appointment_id de outra clínica: 400', async () => {
    const { svc, prisma } = montar({ eventosDoTenant: [] });
    const e = await erro(svc.updateItem('item1', TENANT, { scheduled_appointment_id: 'ev-x' }, ADMIN));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(prisma.treatmentPlanItem.update).not.toHaveBeenCalled();
  });
});
