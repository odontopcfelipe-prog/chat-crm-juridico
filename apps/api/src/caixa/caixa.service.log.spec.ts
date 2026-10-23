/**
 * Fase 0 — H2: o log do caixa grava tenant_id na COLUNA (antes nascia sem clínica)
 * e guarda o estado anterior (status antes/depois; retrato do lançamento apagado).
 * Best-effort: falha no log nunca derruba a operação do caixa.
 */
import { CaixaService } from './caixa.service';

const TENANT = 't1';

function montar(o: { auditFalha?: boolean } = {}) {
  const prisma: any = {
    auditLog: {
      create: o.auditFalha ? jest.fn().mockRejectedValue(new Error('db fora')) : jest.fn().mockResolvedValue({}),
    },
    // Fechado pela recepção (rec1) — o validador (adm1) é outra pessoa.
    cashClosing: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 'cl1', tenant_id: TENANT, closed_by_id: 'rec1' }),
    },
    financialTransaction: { findUnique: jest.fn(), delete: jest.fn().mockResolvedValue({}) },
  };
  const svc = new CaixaService(prisma, {} as any);
  jest.spyOn(svc, 'getClosing').mockResolvedValue({ id: 'cl1' } as any);
  return { svc, prisma };
}

describe('CaixaService.logAction — Fase 0 (H2)', () => {
  it('validar o dia grava tenant_id na coluna e o status antes/depois', async () => {
    const { svc, prisma } = montar();
    await svc.validateDay('cl1', TENANT, 'adm1', { validation_notes: 'ok' } as any);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({
      tenant_id: TENANT, actor_user_id: 'adm1', entity: 'CAIXA', entity_id: 'cl1', action: 'CAIXA_VALIDADO',
    }));
    expect(data.meta_json).toEqual(expect.objectContaining({ obs: 'ok', status_antes: 'FECHADO', status_depois: 'VALIDADO' }));
  });

  it('devolver o dia grava tenant_id e FECHADO → DEVOLVIDO', async () => {
    const { svc, prisma } = montar();
    prisma.cashClosing.findUnique.mockResolvedValue({ id: 'cl1', tenant_id: TENANT, validation_notes: null });
    await svc.returnDay('cl1', TENANT, 'adm1', { validation_notes: 'confere o PIX' } as any);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data.tenant_id).toBe(TENANT);
    expect(data.action).toBe('CAIXA_DEVOLVIDO');
    expect(data.meta_json).toEqual(expect.objectContaining({ status_antes: 'FECHADO', status_depois: 'DEVOLVIDO' }));
  });

  it('apagar lançamento guarda o retrato do que foi apagado', async () => {
    const { svc, prisma } = montar();
    const data = new Date('2026-10-19T13:00:00.000Z');
    prisma.financialTransaction.findUnique.mockResolvedValue({
      id: 'tx1', tenant_id: TENANT, cash_closing_id: 'cl1', cash_closing: { status: 'ABERTO' },
      gateway_charge: null, reference_id: null, description: 'Entrada de caixa', amount: 80,
      type: 'RECEITA', payment_method: 'DINHEIRO', account_id: 'acc1', date: data, lead_id: 'lead1',
    });
    await expect(svc.deleteMovement('tx1', TENANT, 'rec1')).resolves.toEqual({ ok: true });
    const row = prisma.auditLog.create.mock.calls[0][0].data;
    expect(row).toEqual(expect.objectContaining({ tenant_id: TENANT, action: 'CAIXA_LANCAMENTO_REMOVIDO', entity_id: 'tx1' }));
    expect(row.meta_json).toEqual(expect.objectContaining({
      descricao: 'Entrada de caixa',
      valor: 80,
      before: {
        tipo: 'RECEITA', forma: 'DINHEIRO', conta: 'acc1', data: data.toISOString(),
        lead_id: 'lead1', cash_closing_id: 'cl1',
      },
    }));
  });

  it('falha ao gravar o log não derruba a operação', async () => {
    const { svc } = montar({ auditFalha: true });
    await expect(svc.validateDay('cl1', TENANT, 'adm1', {} as any)).resolves.toEqual({ id: 'cl1' });
  });
});
