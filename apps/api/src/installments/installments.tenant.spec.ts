/**
 * Fase 0.1 — isolamento entre clínicas (anti-IDOR) nas rotas de /installments.
 * Um operador da clínica B, com o id de uma parcela/paciente/orçamento da clínica
 * A, recebe 404 e nada é lido nem gravado. Na própria clínica, segue igual.
 */
import { NotFoundException } from '@nestjs/common';
import { InstallmentsService } from './installments.service';

const A = 'tenant-a';
const B = 'tenant-b';

/** Banco fake mínimo: findFirst respeita id + tenant_id (+ patient.tenant_id no quote). */
function montar() {
  const parcelas: any[] = [
    {
      id: 'inst-a', tenant_id: A, patient_id: 'pat-a', quote_id: 'quote-a', status: 'ABERTA',
      amount: 100, amount_paid: 0, discount_value: 0, fee_value: 0,
    },
  ];
  const pacientes: any[] = [{ id: 'pat-a', tenant_id: A }];
  const orcamentos: any[] = [
    { id: 'quote-a', status: 'ACCEPTED', total_value: 300, patient: { id: 'pat-a', tenant_id: A } },
  ];
  const tx: any = {
    installment: {
      findMany: jest.fn().mockResolvedValue([{ id: 'inst-a', amount: 100, amount_paid: 0 }]),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue({ id: 'nova' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma: any = {
    installment: {
      findFirst: jest.fn(async ({ where }: any) =>
        parcelas.find((p) => p.id === where.id && p.tenant_id === where.tenant_id) ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 'criada', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockResolvedValue({ count: 3 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    patient: {
      findFirst: jest.fn(async ({ where }: any) =>
        pacientes.find((p) => p.id === where.id && p.tenant_id === where.tenant_id) ?? null),
      findUnique: jest.fn().mockResolvedValue({ lead_id: null }),
    },
    quote: {
      findFirst: jest.fn(async ({ where }: any) =>
        orcamentos.find((q) => q.id === where.id && q.patient.tenant_id === where.patient?.tenant_id) ?? null),
      findUnique: jest.fn(async ({ where }: any) => orcamentos.find((q) => q.id === where.id) ?? null),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const svc = new InstallmentsService(prisma, { get: jest.fn() } as any);
  return { svc, prisma, tx };
}

describe('InstallmentsService — parcela de OUTRA clínica (por id) dá 404', () => {
  it.each([
    ['findOne', (s: InstallmentsService) => s.findOne(B, 'inst-a')],
    ['update', (s: InstallmentsService) => s.update(B, 'inst-a', { amount: 1 } as any)],
    ['pay', (s: InstallmentsService) => s.pay(B, 'inst-a', { amount_paid: 100, payment_method: 'PIX' } as any)],
    ['cancel', (s: InstallmentsService) => s.cancel(B, 'inst-a', 'x')],
    ['renegotiate', (s: InstallmentsService) =>
      s.renegotiate(B, 'inst-a', { new_total_count: 2, new_first_due_date: '2026-11-01' } as any)],
  ])('%s', async (_nome, chamar) => {
    const { svc, prisma } = montar();
    await expect(chamar(svc)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.installment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inst-a', tenant_id: B } }),
    );
    expect(prisma.installment.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('na própria clínica a baixa segue igual', async () => {
    const { svc, prisma } = montar();
    const r: any = await svc.pay(A, 'inst-a', { amount_paid: 100, payment_method: 'PIX' } as any);
    expect(r.status).toBe('PAGA');
    expect(prisma.installment.update).toHaveBeenCalledTimes(1);
  });
});

describe('InstallmentsService.create — paciente/orçamento têm que ser da clínica', () => {
  const base = { amount: 50, due_date: '2026-11-10' };

  it('paciente de outra clínica → 404, não cria', async () => {
    const { svc, prisma } = montar();
    await expect(svc.create(B, { ...base, patient_id: 'pat-a' } as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.installment.create).not.toHaveBeenCalled();
  });

  it('orçamento de outra clínica → 404, não cria', async () => {
    const { svc, prisma } = montar();
    // Paciente da própria clínica A, mas orçamento "quote-x" não é da A.
    await expect(svc.create(A, { ...base, patient_id: 'pat-a', quote_id: 'quote-x' } as any))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.installment.create).not.toHaveBeenCalled();
  });

  it('na própria clínica cria como antes', async () => {
    const { svc, prisma } = montar();
    const r: any = await svc.create(A, { ...base, patient_id: 'pat-a', quote_id: 'quote-a' } as any);
    expect(r.tenant_id).toBe(A);
    expect(prisma.installment.create).toHaveBeenCalledTimes(1);
  });
});

describe('InstallmentsService.generateFromQuote — orçamento de outra clínica', () => {
  it('responde 404 (igual a inexistente) e não gera parcelas', async () => {
    const { svc, prisma } = montar();
    await expect(svc.generateFromQuote(B, 'quote-a', { total_count: 3, first_due_date: '2026-11-10' } as any))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.installment.createMany).not.toHaveBeenCalled();
  });
});

describe('InstallmentsService.renegotiate — só mexe em parcelas da clínica', () => {
  it('a busca, a contagem e a marcação das antigas filtram o tenant', async () => {
    const { svc, tx } = montar();
    await svc.renegotiate(A, 'inst-a', { new_total_count: 2, new_first_due_date: '2026-11-01' } as any);
    expect(tx.installment.findMany.mock.calls[0][0].where).toMatchObject({ tenant_id: A, quote_id: 'quote-a' });
    expect(tx.installment.count.mock.calls[0][0].where).toMatchObject({ tenant_id: A, quote_id: 'quote-a' });
    expect(tx.installment.updateMany.mock.calls[0][0].where).toMatchObject({ tenant_id: A });
  });
});
