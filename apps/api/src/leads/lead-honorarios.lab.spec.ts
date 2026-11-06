/**
 * Cobrança avulsa do contato (lead-honorarios.service.ts) no laboratório.
 *
 * Laboratório: só alcança contato e parcela da PRÓPRIA conta (registro de outra conta
 * responde como inexistente); a descrição que o financeiro recebe é a do laboratório.
 * Clínica: contato com conta gravada e diferente da conta do token responde 404; contato
 * da própria conta, legado (sem conta) e chamada interna (sem token) seguem como antes.
 *
 * Sem banco: o Prisma é um dublê; dados de exemplo (repositório público).
 */
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';
import { LeadHonorariosService } from './lead-honorarios.service';
import { LAB_COBRANCA_AVULSA } from './lab-cobranca-avulsa-textos';
import { PermissionsGuard } from '../auth/decorators/requires-permission.decorator';

const LAB = 'tenant-lab-exemplo';
const OUTRA = 'tenant-outra-exemplo';
const CLINICA = 'tenant-clinica-exemplo';

beforeEach(() => {
  __limparCacheLabTenants();
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

function montar() {
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    lead: {
      findFirst: jest.fn(async (a: any) => (a.where.tenant_id === LAB && a.where.id === 'contato-lab' ? { id: 'contato-lab' } : null)),
      findUnique: jest.fn(async (a: any) => ({
        tenant_id: a.where.id === 'contato-lab' ? LAB : a.where.id === 'contato-clinica' ? CLINICA : a.where.id === 'contato-legado' ? null : OUTRA,
      })),
    },
    leadHonorario: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async (a: any) =>
        a.where.id === 'hon-lab' ? { id: 'hon-lab', status: 'NEGOCIANDO', tenant_id: LAB, lead_id: 'contato-lab' }
        : a.where.id === 'hon-outra' ? { id: 'hon-outra', status: 'NEGOCIANDO', tenant_id: OUTRA, lead_id: 'contato-outra' }
        : a.where.id === 'hon-legado' ? { id: 'hon-legado', status: 'NEGOCIANDO', tenant_id: null, lead_id: 'contato-outra' }
        : a.where.id === 'hon-clinica' ? { id: 'hon-clinica', status: 'NEGOCIANDO', tenant_id: CLINICA, lead_id: 'contato-clinica' }
        : null),
      create: jest.fn(async (a: any) => ({ id: 'hon-novo', ...a.data })),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
    leadHonorarioPayment: {
      findUnique: jest.fn(async (a: any) =>
        a.where.id === 'par-lab'
          ? { id: 'par-lab', status: 'PENDENTE', lead_honorario_id: 'hon-lab', lead_honorario: { tenant_id: LAB, lead_id: 'contato-lab', type: 'CONTRATUAL', lead: { name: 'Cliente Exemplo' } } }
          : a.where.id === 'par-outra'
            ? { id: 'par-outra', status: 'PENDENTE', lead_honorario_id: 'hon-outra', lead_honorario: { tenant_id: OUTRA, lead_id: 'contato-outra', type: 'CONTRATUAL', lead: { name: 'Outro' } } }
            : a.where.id === 'par-clinica'
              ? { id: 'par-clinica', status: 'PENDENTE', lead_honorario_id: 'hon-clinica', lead_honorario: { tenant_id: CLINICA, lead_id: 'contato-clinica', type: 'CONTRATUAL', lead: { name: 'Cliente' } } }
              : null),
      update: jest.fn(async () => ({ id: 'par-lab' })),
      delete: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
      create: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
    },
    paymentGatewayCharge: { findUnique: jest.fn(async () => null) },
  };
  const financeiro: any = { createFromLeadHonorarioPayment: jest.fn(async () => ({})) };
  const gateway: any = {
    cancelarCobrancaDaParcelaDoLab: jest.fn(async () => undefined),
    baixarCobrancaDaParcelaDoLab: jest.fn(async () => undefined),
  };
  const moduleRef: any = { get: jest.fn(() => gateway) };
  return { svc: new LeadHonorariosService(prisma, financeiro, moduleRef), prisma, financeiro, gateway };
}

const ADMIN = { id: 'u-adm', roles: ['ADMIN'] };
const ATENDENTE = { id: 'u-at', roles: ['OPERADOR'] };

const dados = { type: 'CONTRATUAL', total_value: 100, payments: [{ amount: 100, due_date: '2030-01-10' }] };

describe('cobrança avulsa no laboratório', () => {
  it('lista e cria só para contato da própria conta', async () => {
    const m = montar();
    await expect(m.svc.findByLead('contato-lab', LAB)).resolves.toEqual([]);
    await expect(m.svc.findByLead('contato-outra', LAB)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.lead.findFirst).toHaveBeenCalledWith({ where: { id: 'contato-outra', tenant_id: LAB }, select: { id: true } });

    await expect(m.svc.create('contato-outra', dados, LAB)).rejects.toThrow(LAB_COBRANCA_AVULSA.contatoNaoEncontrado);
    expect(m.prisma.leadHonorario.create).not.toHaveBeenCalled();
    await m.svc.create('contato-lab', dados, LAB);
    expect(m.prisma.leadHonorario.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lead_id: 'contato-lab', tenant_id: LAB }) }));
  });

  it('alterar, apagar, somar parcela, apagar parcela e dar baixa: registro de outra conta responde como inexistente', async () => {
    const m = montar();
    for (const id of ['hon-outra', 'hon-legado']) {
      await expect(m.svc.update(id, { notes: 'x' }, LAB)).rejects.toBeInstanceOf(NotFoundException);
      await expect(m.svc.delete(id, LAB)).rejects.toBeInstanceOf(NotFoundException);
      await expect(m.svc.addPayment(id, { amount: 10, due_date: '2030-01-10' }, LAB)).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(m.svc.deletePayment('par-outra', LAB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.svc.markPaid('par-outra', {}, LAB)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.leadHonorario.update).not.toHaveBeenCalled();
    expect(m.prisma.leadHonorario.delete).not.toHaveBeenCalled();
    expect(m.prisma.leadHonorarioPayment.delete).not.toHaveBeenCalled();
    expect(m.prisma.leadHonorarioPayment.update).not.toHaveBeenCalled();
    expect(m.financeiro.createFromLeadHonorarioPayment).not.toHaveBeenCalled();

    // Os da própria conta passam.
    await m.svc.update('hon-lab', { notes: 'x' }, LAB);
    await m.svc.markPaid('par-lab', {}, LAB);
    expect(m.financeiro.createFromLeadHonorarioPayment).toHaveBeenCalledWith('par-lab', LAB);
  });

  it('clínica: contato de outra conta responde 404 em todas as rotas, sem gravar', async () => {
    const m = montar();
    await expect(m.svc.findByLead('contato-lab', CLINICA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.svc.create('contato-lab', dados, CLINICA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.svc.update('hon-outra', { notes: 'x' }, CLINICA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.svc.delete('hon-outra', CLINICA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.svc.addPayment('hon-outra', { amount: 10, due_date: '2030-01-10' }, CLINICA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.svc.deletePayment('par-outra', CLINICA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.svc.markPaid('par-outra', {}, CLINICA)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.leadHonorario.findMany).not.toHaveBeenCalled();
    expect(m.prisma.leadHonorario.create).not.toHaveBeenCalled();
    expect(m.prisma.leadHonorario.update).not.toHaveBeenCalled();
    expect(m.prisma.leadHonorario.delete).not.toHaveBeenCalled();
    expect(m.prisma.leadHonorarioPayment.update).not.toHaveBeenCalled();
    expect(m.financeiro.createFromLeadHonorarioPayment).not.toHaveBeenCalled();
  });

  it('clínica: contato dela e contato legado (sem conta) seguem como sempre', async () => {
    const m = montar();
    await expect(m.svc.findByLead('contato-clinica', CLINICA)).resolves.toEqual([]);
    await expect(m.svc.findByLead('contato-legado', CLINICA)).resolves.toEqual([]);
    await m.svc.create('contato-clinica', dados, CLINICA);
    await m.svc.update('hon-clinica', { notes: 'x' }, CLINICA);
    await m.svc.markPaid('par-clinica', {}, CLINICA);
    expect(m.prisma.leadHonorario.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.leadHonorario.update).toHaveBeenCalledTimes(1);
    expect(m.financeiro.createFromLeadHonorarioPayment).toHaveBeenCalledWith('par-clinica', CLINICA);
    expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
  });

  it('sem conta no pedido (chamada interna): igual a antes, sem ler o contato', async () => {
    const m = montar();
    await m.svc.findByLead('qualquer');
    expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.lead.findUnique).not.toHaveBeenCalled();
  });

  it('a lista do laboratório traz a cobrança de cada parcela; a da clínica, a consulta de sempre', async () => {
    const m = montar();
    await m.svc.findByLead('contato-lab', LAB);
    expect(m.prisma.leadHonorario.findMany.mock.calls[0][0].include.payments).toEqual({
      orderBy: { due_date: 'asc' },
      include: { gateway_charge: { select: { status: true, received_in_cash: true, boleto_url: true, invoice_url: true } } },
    });
    await m.svc.findByLead('contato-clinica', CLINICA);
    expect(m.prisma.leadHonorario.findMany.mock.calls[1][0].include).toEqual({ payments: { orderBy: { due_date: 'asc' } } });
  });

  describe('parcela com boleto em aberto', () => {
    const comBoleto = (m: ReturnType<typeof montar>, status = 'PENDING') =>
      m.prisma.paymentGatewayCharge.findUnique.mockResolvedValue({ status, received_in_cash: false });

    it('excluir a parcela: cancela no Asaas antes e só então apaga', async () => {
      const m = montar();
      comBoleto(m);
      const ordem: string[] = [];
      m.gateway.cancelarCobrancaDaParcelaDoLab.mockImplementation(async () => { ordem.push('cancela'); });
      m.prisma.leadHonorarioPayment.delete.mockImplementation(async () => { ordem.push('apaga'); return {}; });
      await m.svc.deletePayment('par-lab', LAB, ADMIN);
      expect(ordem).toEqual(['cancela', 'apaga']);
      expect(m.gateway.cancelarCobrancaDaParcelaDoLab).toHaveBeenCalledWith('par-lab', LAB, { userId: 'u-adm', reason: LAB_COBRANCA_AVULSA.motivoExcluirParcela });
    });

    it('o Asaas não confirma o cancelamento: a parcela fica', async () => {
      const m = montar();
      comBoleto(m);
      m.gateway.cancelarCobrancaDaParcelaDoLab.mockRejectedValue(new BadRequestException(LAB_COBRANCA_AVULSA.asaasNaoConfirmouCancelamento));
      await expect(m.svc.deletePayment('par-lab', LAB, ADMIN)).rejects.toThrow(LAB_COBRANCA_AVULSA.asaasNaoConfirmouCancelamento);
      expect(m.prisma.leadHonorarioPayment.delete).not.toHaveBeenCalled();
    });

    it('quem não é administrador não cancela o boleto: recusa com a mensagem clara, sem tocar no Asaas', async () => {
      const m = montar();
      comBoleto(m);
      await expect(m.svc.deletePayment('par-lab', LAB, ATENDENTE)).rejects.toThrow(LAB_COBRANCA_AVULSA.soAdminCancelaBoleto);
      expect(m.gateway.cancelarCobrancaDaParcelaDoLab).not.toHaveBeenCalled();
      expect(m.prisma.leadHonorarioPayment.delete).not.toHaveBeenCalled();
    });

    it('parcela sem boleto, ou com o boleto já cancelado: qualquer um exclui, como antes', async () => {
      const m = montar();
      await m.svc.deletePayment('par-lab', LAB, ATENDENTE);
      expect(m.prisma.leadHonorarioPayment.delete).toHaveBeenCalledTimes(1);
      const c = montar();
      comBoleto(c, 'DELETED');
      await c.svc.deletePayment('par-lab', LAB, ATENDENTE);
      expect(c.prisma.leadHonorarioPayment.delete).toHaveBeenCalledTimes(1);
    });

    it('excluir a cobrança avulsa: cancela o boleto de cada parcela antes de apagar', async () => {
      const m = montar();
      comBoleto(m);
      m.prisma.leadHonorarioPayment.findMany.mockResolvedValue([
        { id: 'p1', status: 'PENDENTE', gateway_charge: { status: 'PENDING', received_in_cash: false } },
        { id: 'p2', status: 'ATRASADO', gateway_charge: { status: 'OVERDUE', received_in_cash: false } },
      ]);
      await m.svc.delete('hon-lab', LAB, ADMIN);
      expect(m.gateway.cancelarCobrancaDaParcelaDoLab.mock.calls.map((c: any[]) => [c[0], c[2].reason])).toEqual([
        ['p1', LAB_COBRANCA_AVULSA.motivoExcluirCobranca],
        ['p2', LAB_COBRANCA_AVULSA.motivoExcluirCobranca],
      ]);
      expect(m.prisma.leadHonorario.delete).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['parcela paga à mão', { id: 'p1', status: 'PAGO', gateway_charge: null }],
      ['boleto pago', { id: 'p1', status: 'PENDENTE', gateway_charge: { status: 'RECEIVED', received_in_cash: false } }],
    ])('excluir a cobrança avulsa com %s: recusa, sem cancelar nem apagar nada', async (_n, parcela) => {
      const m = montar();
      m.prisma.leadHonorarioPayment.findMany.mockResolvedValue([parcela]);
      await expect(m.svc.delete('hon-lab', LAB, ADMIN)).rejects.toThrow(LAB_COBRANCA_AVULSA.temParcelaPaga);
      expect(m.gateway.cancelarCobrancaDaParcelaDoLab).not.toHaveBeenCalled();
      expect(m.prisma.leadHonorario.delete).not.toHaveBeenCalled();
    });

    it('marcar como paga: dá baixa no boleto e não abre um segundo lançamento', async () => {
      const m = montar();
      comBoleto(m);
      await m.svc.markPaid('par-lab', { payment_method: 'PIX' }, LAB, ADMIN);
      expect(m.gateway.baixarCobrancaDaParcelaDoLab).toHaveBeenCalledWith('par-lab', LAB, { userId: 'u-adm', paymentMethod: 'PIX' });
      expect(m.prisma.leadHonorarioPayment.update).not.toHaveBeenCalled();
      expect(m.financeiro.createFromLeadHonorarioPayment).not.toHaveBeenCalled();
    });

    it('marcar como paga sem ser do Caixa, do Financeiro nem administrador: recusa, sem tocar no Asaas', async () => {
      const m = montar();
      comBoleto(m);
      jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set() as any);
      await expect(m.svc.markPaid('par-lab', {}, LAB, ATENDENTE)).rejects.toBeInstanceOf(ForbiddenException);
      expect(m.gateway.baixarCobrancaDaParcelaDoLab).not.toHaveBeenCalled();
      expect(m.prisma.leadHonorarioPayment.update).not.toHaveBeenCalled();
    });

    it('marcar como paga sem boleto em aberto: o caminho de sempre', async () => {
      const m = montar();
      await m.svc.markPaid('par-lab', {}, LAB);
      expect(m.prisma.leadHonorarioPayment.update).toHaveBeenCalledTimes(1);
      expect(m.financeiro.createFromLeadHonorarioPayment).toHaveBeenCalledWith('par-lab', LAB);
      expect(m.gateway.baixarCobrancaDaParcelaDoLab).not.toHaveBeenCalled();
    });

    it('clínica: não olha cobrança nenhuma, não fala com o gateway e apaga como sempre', async () => {
      const m = montar();
      await m.svc.deletePayment('par-clinica', CLINICA, ATENDENTE);
      await m.svc.markPaid('par-clinica', {}, CLINICA, ATENDENTE);
      await m.svc.delete('hon-clinica', CLINICA, ATENDENTE);
      expect(m.prisma.paymentGatewayCharge.findUnique).not.toHaveBeenCalled();
      expect(m.prisma.leadHonorarioPayment.findMany).not.toHaveBeenCalled();
      expect(m.gateway.cancelarCobrancaDaParcelaDoLab).not.toHaveBeenCalled();
      expect(m.gateway.baixarCobrancaDaParcelaDoLab).not.toHaveBeenCalled();
      expect(m.prisma.leadHonorarioPayment.delete).toHaveBeenCalledTimes(1);
      expect(m.prisma.leadHonorario.delete).toHaveBeenCalledTimes(1);
      expect(m.financeiro.createFromLeadHonorarioPayment).toHaveBeenCalledTimes(1);
    });
  });

  it('descrição do laboratório: tipo e cliente, sem texto de clínica', () => {
    expect(LAB_COBRANCA_AVULSA.descricao('CONTRATUAL', 'Cliente Exemplo')).toBe('Cobrança avulsa - Cliente Exemplo');
    expect(LAB_COBRANCA_AVULSA.descricao('ENTRADA', 'Cliente Exemplo', 3)).toBe('Entrada - Cliente Exemplo (3x)');
    expect(LAB_COBRANCA_AVULSA.descricao('ACORDO', null, 1)).toBe('Acordo - Cliente');
    const textos = [
      ...Object.values(LAB_COBRANCA_AVULSA.tipos),
      LAB_COBRANCA_AVULSA.descricao('CONTRATUAL', 'X', 2),
      LAB_COBRANCA_AVULSA.contatoNaoEncontrado,
      LAB_COBRANCA_AVULSA.naoEncontrada,
      LAB_COBRANCA_AVULSA.parcelaNaoEncontrada,
      LAB_COBRANCA_AVULSA.semParcelaPendente,
      LAB_COBRANCA_AVULSA.contatoSemDocumento,
      LAB_COBRANCA_AVULSA.descricaoDaParcela('CONTRATUAL', 'X', 2, 3),
      LAB_COBRANCA_AVULSA.erroNoAsaas('falhou'),
      LAB_COBRANCA_AVULSA.asaasNaoConfirmouCancelamento,
      LAB_COBRANCA_AVULSA.soAdminCancelaBoleto,
      LAB_COBRANCA_AVULSA.soCaixaDaBaixa,
      LAB_COBRANCA_AVULSA.boletoJaPago,
      LAB_COBRANCA_AVULSA.temParcelaPaga,
      LAB_COBRANCA_AVULSA.motivoExcluirParcela,
      LAB_COBRANCA_AVULSA.motivoExcluirCobranca,
    ];
    for (const t of textos) expect(temPalavraDeClinica(t)).toBe(false);
  });
});
