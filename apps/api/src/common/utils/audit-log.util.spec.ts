/**
 * Fase 0 — helper de auditoria: tenant na coluna, before/after no meta, JSON limpo
 * e registro best-effort (nunca derruba quem chama).
 */
import { auditData, registrarAuditoria } from './audit-log.util';

describe('auditData', () => {
  it('põe tenant_id e actor_user_id na COLUNA', () => {
    const d = auditData({ tenantId: 't1', actorUserId: 'u1', entity: 'FINANCEIRO', entityId: 'c1', action: 'X' });
    expect(d.tenant_id).toBe('t1');
    expect(d.actor_user_id).toBe('u1');
    expect(d.entity).toBe('FINANCEIRO');
    expect(d.entity_id).toBe('c1');
    expect(d.action).toBe('X');
  });

  it('sem ator e sem tenant grava null (nunca "system")', () => {
    const d = auditData({ tenantId: null, entity: 'CAIXA', entityId: 'x', action: 'Y' });
    expect(d.tenant_id).toBeNull();
    expect(d.actor_user_id).toBeNull();
  });

  it('before e after entram no meta junto com o resto', () => {
    const d = auditData({
      tenantId: 't1', entity: 'FINANCEIRO', entityId: 'c1', action: 'X',
      before: { status: 'PENDING' }, after: { status: 'RECEIVED' },
      meta: { descricao: 'Baixa', valor: 100 },
    });
    expect(d.meta_json).toEqual({
      descricao: 'Baixa', valor: 100,
      before: { status: 'PENDING' }, after: { status: 'RECEIVED' },
    });
  });

  it('sem before/after grava null; "before" que já veio no meta é mantido', () => {
    expect(auditData({ tenantId: 't', entity: 'E', entityId: 'i', action: 'a' }).meta_json).toEqual({ before: null, after: null });
    const d = auditData({ tenantId: 't', entity: 'CAIXA', entityId: 'i', action: 'a', meta: { before: { tipo: 'RECEITA' } } });
    expect(d.meta_json.before).toEqual({ tipo: 'RECEITA' });
  });

  it('Date vira string ISO, Decimal vira string e BigInt não lança', () => {
    const when = new Date('2026-10-19T12:00:00.000Z');
    const decimalLike = { toJSON: () => '150.5' };
    const d = auditData({
      tenantId: 't', entity: 'E', entityId: 'i', action: 'a',
      before: { data: when }, meta: { valor: decimalLike, n: BigInt(7) },
    });
    expect(d.meta_json.before.data).toBe('2026-10-19T12:00:00.000Z');
    expect(d.meta_json.valor).toBe('150.5');
    expect(d.meta_json.n).toBe('7');
  });
});

describe('registrarAuditoria', () => {
  it('grava pelo create e devolve true', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'a1' });
    const ok = await registrarAuditoria({ auditLog: { create } }, { tenantId: 't1', entity: 'FINANCEIRO', entityId: 'c1', action: 'X' });
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenant_id: 't1', entity: 'FINANCEIRO' }) });
  });

  it('create que rejeita devolve false sem lançar e avisa no logger', async () => {
    const create = jest.fn().mockRejectedValue(new Error('FK quebrada'));
    const warn = jest.fn();
    await expect(
      registrarAuditoria({ auditLog: { create } }, { tenantId: 't1', entity: 'FINANCEIRO', entityId: 'c1', action: 'X' }, { warn }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FK quebrada'));
  });

  it('sem logger também não lança', async () => {
    const create = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(registrarAuditoria({ auditLog: { create } }, { tenantId: null, entity: 'E', entityId: 'i', action: 'a' })).resolves.toBe(false);
  });
});
