/**
 * Nota fiscal por id só da própria conta: ler (GET /nota-fiscal/:id), emitir
 * (POST /nota-fiscal/emit, pela transação) e cancelar (POST /nota-fiscal/:id/cancel).
 *
 *  - nota ou transação de outra conta → 403, nada lido além do registro, nada gravado;
 *  - nota ou transação sem conta (tenant_id NULL) → a mesma 403;
 *  - registro da própria conta → as mesmas chamadas e respostas de antes;
 *  - id que não existe → 404 como antes;
 *  - SUPER_ADMIN sem conta (tenantId undefined) → como antes.
 */
import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { NotaFiscalService } from './nota-fiscal.service';
import { NotaFiscalController } from './nota-fiscal.controller';

const A = 'conta-a';
const B = 'conta-b';

const LEAD_A = { id: 'lead-a', name: 'Maria Exemplo', phone: '5582900000001', email: 'maria@exemplo.com' };

const TRANSACOES: Record<string, any> = {
  'tx-a': { id: 'tx-a', tenant_id: A, amount: 200, lead_id: 'lead-a', lead: LEAD_A },
  'tx-b': { id: 'tx-b', tenant_id: B, amount: 300, lead_id: null, lead: null },
  'tx-0': { id: 'tx-0', tenant_id: null, amount: 400, lead_id: null, lead: null },
  'tx-a-com-nota': { id: 'tx-a-com-nota', tenant_id: A, amount: 90, lead_id: null, lead: null },
};

const NOTAS: Record<string, any> = {
  'nf-a': { id: 'nf-a', tenant_id: A, transaction_id: 'tx-a-com-nota', status: 'EMITIDA', provider: 'ENOTAS' },
  'nf-a-cancelada': { id: 'nf-a-cancelada', tenant_id: A, transaction_id: 'tx-x', status: 'CANCELADA', provider: 'ENOTAS' },
  'nf-b': { id: 'nf-b', tenant_id: B, transaction_id: 'tx-b-antiga', status: 'EMITIDA', provider: 'ENOTAS' },
  'nf-0': { id: 'nf-0', tenant_id: null, transaction_id: 'tx-0-antiga', status: 'EMITIDA', provider: 'ENOTAS' },
};

// Configuração de NFS-e por conta (chave `nfse_*_<conta>`).
const CONFIG: Record<string, string> = {
  [`nfse_provider_${A}`]: 'enotas',
  [`nfse_api_key_${A}`]: 'chave-a',
  [`nfse_cnpj_${A}`]: '11222333000181',
  [`nfse_auto_emit_${A}`]: 'true',
  [`nfse_provider_${B}`]: 'focusnfe',
  [`nfse_api_key_${B}`]: 'chave-b',
};

const INCLUDE_FINDONE = {
  transaction: {
    select: { id: true, description: true, amount: true, status: true, category: true, date: true, payment_method: true },
  },
  lead: { select: { id: true, name: true, phone: true, email: true } },
};

function montar() {
  const escritas: string[] = [];
  const prisma: any = {
    notaFiscal: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return NOTAS[where.id] ? { ...NOTAS[where.id] } : null;
        const nf = Object.values(NOTAS).find((n) => n.transaction_id === where.transaction_id);
        return nf ? { ...nf } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        escritas.push('notaFiscal.create');
        return { id: 'nf-nova', ...data };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        escritas.push('notaFiscal.update');
        return { ...NOTAS[where.id], ...data };
      }),
    },
    financialTransaction: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const t = TRANSACOES[where.id];
        if (!t) return null;
        return select ? { tenant_id: t.tenant_id } : { ...t };
      }),
    },
  };
  const settings = { get: jest.fn(async (key: string) => CONFIG[key] ?? null) };
  const svc = new NotaFiscalService(prisma, settings as any);
  const ctl = new NotaFiscalController(svc);
  return { svc, ctl, prisma, settings, escritas };
}

const req = (tenant_id?: string) => ({ user: { id: 'u-1', roles: ['ADMIN'], tenant_id } });

beforeEach(() => {
  // A emissão simulada registra o payload no log; o teste não precisa dele.
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('GET /nota-fiscal/:id — só nota da própria conta', () => {
  it.each(['nf-b', 'nf-0'])('nota %s com a conta A → 403', async (id) => {
    const m = montar();
    const e = await m.ctl.findOne(id, req(A)).catch((x) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.message).toBe('Acesso negado a este recurso');
  });

  it('própria conta: mesma leitura e mesma nota de antes', async () => {
    const m = montar();
    expect(await m.ctl.findOne('nf-a', req(A))).toEqual(NOTAS['nf-a']);
    expect(m.prisma.notaFiscal.findUnique.mock.calls).toEqual([[{ where: { id: 'nf-a' }, include: INCLUDE_FINDONE }]]);
  });

  it('id que não existe → 404 como antes', async () => {
    const m = montar();
    await expect(m.ctl.findOne('nao-existe', req(A))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SUPER_ADMIN sem conta: lê nota de qualquer conta e nota sem conta, como antes', async () => {
    const m = montar();
    expect((await m.ctl.findOne('nf-0', req(undefined))).id).toBe('nf-0');
    expect((await m.ctl.findOne('nf-b', req(undefined))).id).toBe('nf-b');
  });
});

describe('POST /nota-fiscal/emit — só transação da própria conta', () => {
  it.each(['tx-b', 'tx-0'])('transação %s com a conta A → 403, sem ler configuração nem gravar nota', async (id) => {
    const m = montar();
    const e = await m.ctl.emit({ transactionId: id } as any, req(A)).catch((x) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.message).toBe('Acesso negado a esta transacao');
    expect(m.prisma.notaFiscal.findUnique).not.toHaveBeenCalled();
    expect(m.settings.get).not.toHaveBeenCalled();
    expect(m.escritas).toEqual([]);
  });

  it('própria conta: mesma leitura da transação e nota gravada na conta, como antes', async () => {
    const m = montar();
    const nf = await m.ctl.emit({ transactionId: 'tx-a' } as any, req(A));

    expect(m.prisma.financialTransaction.findUnique.mock.calls[0][0]).toEqual({
      where: { id: 'tx-a' },
      include: { lead: { select: { id: true, name: true, phone: true, email: true } } },
    });
    expect(m.prisma.notaFiscal.findUnique.mock.calls[0][0]).toEqual({ where: { transaction_id: 'tx-a' } });
    expect(m.settings.get.mock.calls.map((c: any[]) => c[0])).toEqual([
      `nfse_provider_${A}`,
      `nfse_api_key_${A}`,
      `nfse_cnpj_${A}`,
      `nfse_inscricao_municipal_${A}`,
      `nfse_cnae_code_${A}`,
      `nfse_default_iss_rate_${A}`,
      `nfse_servico_descricao_${A}`,
    ]);
    expect(m.prisma.notaFiscal.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.notaFiscal.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: A,
      transaction_id: 'tx-a',
      lead_id: 'lead-a',
      status: 'EMITIDA',
      valor: 200,
      tomador_nome: 'Maria Exemplo',
      tomador_email: 'maria@exemplo.com',
      provider: 'ENOTAS',
    });
    expect(nf.status).toBe('EMITIDA');
    expect(m.escritas).toEqual(['notaFiscal.create']);
  });

  it('própria conta com nota já emitida para a transação → devolve a existente, como antes', async () => {
    const m = montar();
    expect(await m.ctl.emit({ transactionId: 'tx-a-com-nota' } as any, req(A))).toEqual(NOTAS['nf-a']);
    expect(m.escritas).toEqual([]);
  });

  it('transação que não existe → 404 como antes', async () => {
    const m = montar();
    await expect(m.ctl.emit({ transactionId: 'nao-existe' } as any, req(A))).rejects.toBeInstanceOf(NotFoundException);
    expect(m.escritas).toEqual([]);
  });

  it('SUPER_ADMIN sem conta: usa a configuração da conta da transação, como antes', async () => {
    const m = montar();
    await m.ctl.emit({ transactionId: 'tx-b' } as any, req(undefined));
    expect(m.settings.get.mock.calls[0][0]).toBe(`nfse_provider_${B}`);
    expect(m.prisma.notaFiscal.create.mock.calls[0][0].data).toMatchObject({ tenant_id: B, provider: 'FOCUSNFE' });
  });

  it('SUPER_ADMIN sem conta e transação sem conta: configuração incompleta (400), como antes', async () => {
    const m = montar();
    await expect(m.ctl.emit({ transactionId: 'tx-0' } as any, req(undefined))).rejects.toBeInstanceOf(BadRequestException);
    expect(m.escritas).toEqual([]);
  });
});

describe('autoEmitIfEnabled — segue a mesma regra da emissão', () => {
  it('própria conta com emissão automática ligada → emite como antes', async () => {
    const m = montar();
    const nf = await m.svc.autoEmitIfEnabled('tx-a', A);
    expect(nf?.tenant_id).toBe(A);
    expect(m.escritas).toEqual(['notaFiscal.create']);
  });

  it('transação sem conta com a conta A → 403 e nada gravado', async () => {
    const m = montar();
    await expect(m.svc.autoEmitIfEnabled('tx-0', A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.escritas).toEqual([]);
  });
});

describe('POST /nota-fiscal/:id/cancel — só nota da própria conta', () => {
  it.each(['nf-b', 'nf-0'])('nota %s com a conta A → 403 e nada gravado', async (id) => {
    const m = montar();
    const e = await m.ctl.cancel(id, req(A)).catch((x) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.message).toBe('Acesso negado a este recurso');
    expect(m.escritas).toEqual([]);
  });

  it('própria conta: mesmo update de antes', async () => {
    const m = montar();
    const nf = await m.ctl.cancel('nf-a', req(A));
    expect(m.prisma.notaFiscal.findUnique.mock.calls).toEqual([[{ where: { id: 'nf-a' } }]]);
    expect(m.prisma.notaFiscal.update.mock.calls).toEqual([
      [{ where: { id: 'nf-a' }, data: { status: 'CANCELADA', cancelada_em: expect.any(Date) } }],
    ]);
    expect(nf.status).toBe('CANCELADA');
  });

  it('própria conta: nota já cancelada → 409 como antes; id que não existe → 404', async () => {
    const m = montar();
    await expect(m.ctl.cancel('nf-a-cancelada', req(A))).rejects.toBeInstanceOf(ConflictException);
    await expect(m.ctl.cancel('nao-existe', req(A))).rejects.toBeInstanceOf(NotFoundException);
    expect(m.escritas).toEqual([]);
  });

  it('SUPER_ADMIN sem conta: cancela nota sem conta, como antes', async () => {
    const m = montar();
    await m.ctl.cancel('nf-0', req(undefined));
    expect(m.escritas).toEqual(['notaFiscal.update']);
  });
});
