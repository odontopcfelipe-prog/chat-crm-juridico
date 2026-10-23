import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { REQUIRES_PERMISSION_KEY } from './decorators/requires-permission.decorator';
import { ROLES_KEY } from './decorators/roles.decorator';
import { InstallmentsController } from '../installments/installments.controller';
import { InstallmentsService } from '../installments/installments.service';
import { CaixaController } from '../caixa/caixa.controller';
import { CaixaService } from '../caixa/caixa.service';
import { CommercialController } from '../commercial/commercial.controller';

// Antifraude (out/2026) — os 4 furos fechados: parcela, "sem cobrar", contas do
// caixa e validar o próprio caixa. A regra mora na API (a tela só acompanha).

const perm = (fn: unknown) => Reflect.getMetadata(REQUIRES_PERMISSION_KEY, fn as object);
const roles = (fn: unknown) => Reflect.getMetadata(ROLES_KEY, fn as object);

describe('Furo 1 — parcelas: só o Financeiro escreve', () => {
  const c = InstallmentsController.prototype;
  it.each([
    ['create', c.create], ['generate', c.generate], ['update', c.update],
    ['pay', c.pay], ['cancel', c.cancel], ['renegotiate', c.renegotiate],
  ])('%s exige manage_financial', (_n, fn) => {
    expect(perm(fn)).toEqual(['manage_financial']);
  });

  function svc(inst: Record<string, unknown> = {}) {
    const parcela = {
      id: 'p1', tenant_id: 't1', patient_id: 'pac', sequence: 2, total_count: 6,
      amount: 300, amount_paid: 0, discount_value: 0, fee_value: 0, status: 'ABERTA', due_date: new Date(), notes: null,
      ...inst,
    };
    const audit: any[] = [];
    const prisma: any = {
      installment: {
        findFirst: jest.fn(async () => parcela),
        update: jest.fn(async ({ data }: any) => ({ ...parcela, ...data })),
      },
      patient: { findUnique: jest.fn(async () => ({ lead_id: null })) },
      auditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
    };
    return { s: new InstallmentsService(prisma, { get: jest.fn() } as any), prisma, audit };
  }

  it('baixa com data no futuro é recusada', async () => {
    const { s, prisma } = svc();
    const amanha = new Date(Date.now() + 86400_000).toISOString();
    await expect(s.pay('t1', 'p1', { amount_paid: 300, payment_method: 'PIX', paid_at: amanha } as any, 'u1'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.installment.update).not.toHaveBeenCalled();
  });

  it('baixa grava quem deu, quanto e a forma', async () => {
    const { s, audit } = svc();
    await s.pay('t1', 'p1', { amount_paid: 300, payment_method: 'DINHEIRO', notes: 'recebido no balcão' } as any, 'u-fin');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'PARCELA_BAIXA_MANUAL', actor_user_id: 'u-fin', tenant_id: 't1' });
    expect(JSON.stringify(audit[0])).toContain('DINHEIRO');
  });

  it('cancelar exige motivo e fica no rastro', async () => {
    const { s, audit } = svc();
    await expect(s.cancel('t1', 'p1', '  ', 'u-fin')).rejects.toBeInstanceOf(BadRequestException);
    await s.cancel('t1', 'p1', 'paciente desistiu', 'u-fin');
    expect(audit[0]).toMatchObject({ action: 'PARCELA_CANCELADA', actor_user_id: 'u-fin' });
  });

  it('mudar valor grava antes → depois', async () => {
    const { s, audit } = svc();
    await s.update('t1', 'p1', { amount: 100 } as any, 'u-fin');
    const meta = JSON.parse(JSON.stringify(audit[0].meta_json));
    expect(meta.before.valor).toBe(300);
    expect(meta.after.valor).toBe(100);
  });
});

describe('Furo 2 — "Adicionar ao tratamento sem cobrar": só o administrador', () => {
  it('a rota exige papel ADMIN (não basta manage_proposals)', () => {
    const fn = CommercialController.prototype.acceptQuoteNoCharge;
    expect(roles(fn)).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(perm(fn)).toBeUndefined();
  });
});

describe('Furo 3 — contas do caixa: só Financeiro/ADM', () => {
  it('criar e renomear conta exigem manage_financial; lançar segue com operate_cash', () => {
    const c = CaixaController.prototype;
    expect(perm(c.createAccount)).toEqual(['manage_financial']);
    expect(perm(c.updateAccount)).toEqual(['manage_financial']);
    expect(perm(c.addMovement)).toBeUndefined(); // herda o operate_cash da classe
    expect(Reflect.getMetadata(REQUIRES_PERMISSION_KEY, CaixaController)).toEqual(['operate_cash']);
  });
});

describe('Furo 4 — quem fechou não valida o próprio caixa', () => {
  function svc(closedBy: string | null) {
    const prisma: any = {
      cashClosing: {
        findUnique: jest.fn(async () => ({ id: 'c1', tenant_id: 't1', closed_by_id: closedBy })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    const s = new CaixaService(prisma, {} as any);
    jest.spyOn(s, 'getClosing').mockResolvedValue({ id: 'c1' } as any);
    return { s, prisma };
  }

  it('o Financeiro que fechou é barrado', async () => {
    const { s, prisma } = svc('u-fin');
    await expect(s.validateDay('c1', 't1', 'u-fin', {} as any, ['FINANCEIRO'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.cashClosing.updateMany).not.toHaveBeenCalled();
  });

  it('outra pessoa do Financeiro valida', async () => {
    const { s, prisma } = svc('u-recep');
    await s.validateDay('c1', 't1', 'u-fin', {} as any, ['FINANCEIRO']);
    expect(prisma.cashClosing.updateMany).toHaveBeenCalled();
  });

  it('o administrador pode validar o que ele mesmo fechou (fica marcado no rastro)', async () => {
    const { s, prisma } = svc('u-adm');
    await s.validateDay('c1', 't1', 'u-adm', {} as any, ['ADMIN']);
    expect(prisma.cashClosing.updateMany).toHaveBeenCalled();
    expect(JSON.stringify(prisma.auditLog.create.mock.calls[0][0])).toContain('validou_o_proprio_fechamento');
  });

  it('fechamento de outra clínica dá 404', async () => {
    const { s } = svc('u-x');
    await expect(s.validateDay('c1', 't2', 'u-fin', {} as any, ['FINANCEIRO'])).rejects.toThrow('Fechamento nao encontrado');
  });
});
