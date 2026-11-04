/** Lista de vendas da Venda Rápida: textos da forma, estado e o isolamento por conta. */
import { QuotesService } from './quotes.service';
import { estadoDaVenda, formaDaVendaRapida } from './venda-rapida.util';

describe('formaDaVendaRapida', () => {
  it.each([
    ['Venda rapida — recebido na clinica: Espécie', 'Dinheiro'],
    ['Venda rapida — recebido na clinica: PIX da clínica', 'PIX na chave'],
    ['Venda rapida — recebido no laboratorio: PIX do laboratório', 'PIX na chave'],
    ['Venda rapida — recebido na clinica: PIX (Maquineta)', 'PIX na maquineta'],
    ['Venda rapida — recebido na clinica: Maquineta', 'Cartão'],
    ['Venda rapida — recebido na clinica: Maquineta (2 cartões)', '2 cartões'],
    [
      'Venda rapida — recebido na clinica (varias formas): PIX da clínica R$ 100.00 + Espécie R$ 50.50',
      'PIX na chave R$ 100,00 + Dinheiro R$ 50,50',
    ],
  ])('%s', (notas, esperado) => {
    expect(formaDaVendaRapida(notas)).toBe(esperado);
  });

  it('sem forma nas notas devolve null', () => {
    expect(formaDaVendaRapida('Venda rapida (balcao sem avaliacao)')).toBeNull();
    expect(formaDaVendaRapida(null)).toBeNull();
  });
});

describe('estadoDaVenda', () => {
  it.each([
    [['RECEIVED'], 'RECEBIDA'],
    [['CONFIRMED'], 'RECEBIDA'],
    [['RECEIVED_IN_CASH'], 'RECEBIDA'],
    [['DELETED', 'RECEIVED'], 'RECEBIDA'],
    [['OVERDUE'], 'VENCIDA'],
    [['PENDING'], 'PENDENTE'],
    [['CANCELLED'], 'CANCELADA'],
    [['REFUNDED'], 'CANCELADA'],
    [[], 'SEM_COBRANCA'],
  ])('%j = %s', (status, esperado) => {
    expect(estadoDaVenda(status as string[])).toBe(esperado);
  });
});

describe('listarVendasRapidas', () => {
  const venda = {
    id: 'q1',
    quote_number: 12,
    notes: 'Venda rapida — recebido na clinica: Espécie',
    total_value: 150,
    created_at: new Date('2026-11-04T12:00:00Z'),
    patient: { id: 'p1', name: 'Maria', phone: '82999990000' },
    items: [{ procedure: { name: 'Limpeza' } }, { procedure: { name: 'Flúor' } }],
    _count: { items: 3 },
    treatment_plan: { id: 'plano1', validated_by_financial_at: null },
  };

  function montar(vendas: unknown[] = [venda], cobrancas: unknown[] = [{ treatment_plan_id: 'plano1', status: 'RECEIVED', billing_type: 'PIX' }]) {
    const prisma = {
      quote: {
        findMany: jest.fn(async () => vendas),
        count: jest.fn(async () => vendas.length),
        aggregate: jest.fn(async () => ({ _sum: { total_value: 150 } })),
      },
      paymentGatewayCharge: { findMany: jest.fn(async () => cobrancas) },
    };
    const service = Object.create(QuotesService.prototype) as QuotesService;
    (service as unknown as { prisma: typeof prisma }).prisma = prisma;
    return { service, prisma };
  }

  const whereDe = (prisma: ReturnType<typeof montar>['prisma']) =>
    (prisma.quote.findMany.mock.calls as unknown as Array<[{ where: any; skip: number; take: number }]>)[0][0];

  it('só a conta do usuário, só venda rápida aceita e não excluída', async () => {
    const { service, prisma } = montar();
    await service.listarVendasRapidas('tenant-a');
    const { where } = whereDe(prisma);
    expect(where.patient).toEqual({ tenant_id: 'tenant-a' });
    expect(where.status).toBe('ACCEPTED');
    expect(where.deleted_at).toBeNull();
    expect(JSON.stringify(where.AND[0])).toContain('Venda rapida');
    expect(JSON.stringify(where.AND[0])).toContain('Venda rápida');
    // O total e a soma usam o MESMO filtro da lista.
    expect(prisma.quote.count).toHaveBeenCalledWith({ where });
    expect(prisma.quote.aggregate).toHaveBeenCalledWith({ where, _sum: { total_value: true } });
  });

  it('monta a linha da venda', async () => {
    const { service } = montar();
    const r = await service.listarVendasRapidas('tenant-a');
    expect(r.data[0]).toMatchObject({
      numero: 12,
      cliente: { id: 'p1', name: 'Maria' },
      itens: ['Limpeza', 'Flúor'],
      qtd_itens: 3,
      forma: 'Dinheiro',
      total: 150,
      estado: 'RECEBIDA',
      a_validar: true,
    });
    expect(r).toMatchObject({ total: 1, soma: 150, page: 1, totalPages: 1 });
  });

  it('venda já validada não aparece como "a validar"; pendente também não', async () => {
    const validada = { ...venda, treatment_plan: { id: 'plano1', validated_by_financial_at: new Date() } };
    expect((await montar([validada]).service.listarVendasRapidas('t')).data[0].a_validar).toBe(false);
    const pendente = montar([venda], [{ treatment_plan_id: 'plano1', status: 'PENDING', billing_type: 'PIX' }]);
    expect((await pendente.service.listarVendasRapidas('t')).data[0]).toMatchObject({ estado: 'PENDENTE', a_validar: false });
  });

  it('PIX online antigo, sem forma nas notas, usa a cobrança', async () => {
    const antiga = { ...venda, notes: 'Venda rapida (balcao sem avaliacao)' };
    expect((await montar([antiga]).service.listarVendasRapidas('t')).data[0].forma).toBe('PIX online');
  });

  it('busca por número da venda só quando é número; cliente sempre', async () => {
    const porNumero = montar();
    await porNumero.service.listarVendasRapidas('t', { search: '12' });
    expect(JSON.stringify(whereDe(porNumero.prisma).where.AND[1])).toContain('"quote_number":12');
    const porNome = montar();
    await porNome.service.listarVendasRapidas('t', { search: 'Maria' });
    const texto = JSON.stringify(whereDe(porNome.prisma).where.AND[1]);
    expect(texto).not.toContain('quote_number');
    expect(texto).toContain('Maria');
  });

  it('página e limite ficam na faixa; data inválida é ignorada em vez de quebrar', async () => {
    const { service, prisma } = montar();
    const r = await service.listarVendasRapidas('t', { page: 3, perPage: 5000, from: 'lixo', to: 'lixo' });
    const q = whereDe(prisma);
    expect(q.take).toBe(100);
    expect(q.skip).toBe(200);
    expect(q.where.created_at).toBeUndefined();
    expect(r.perPage).toBe(100);
  });

  it('sem plano na página não busca cobrança nenhuma', async () => {
    const { service, prisma } = montar([{ ...venda, treatment_plan: null }], []);
    const r = await service.listarVendasRapidas('t');
    expect(prisma.paymentGatewayCharge.findMany).not.toHaveBeenCalled();
    expect(r.data[0].estado).toBe('SEM_COBRANCA');
  });
});
