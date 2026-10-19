import { BadRequestException, ConflictException } from '@nestjs/common';
import { QuotesService } from './quotes.service';

/**
 * Fase 0 — I4: venda de BALCÃO em UMA operação (POST venda-rapida/balcao).
 * Total no servidor, soma das formas = total, dentista obrigatório, nada gravado antes
 * de validar, cobrança local + caixa via approveAndBill (5º argumento interno),
 * auto-liberação do plano só com receita, compensação e idempotência.
 */
describe('QuotesService.vendaBalcao (Fase 0)', () => {
  const TENANT = 't-balcao';
  const USER = 'u-recepcao';
  const DENT = 'd-1';
  const PROC_A = 'proc-a'; // R$ 120
  const PROC_B = 'proc-b'; // R$ 80
  const KEY = '44444444-4444-4444-8444-444444444444';

  function montar() {
    const audits: any[] = [];
    const prisma: any = {
      user: { findMany: jest.fn().mockResolvedValue([{ id: DENT, name: 'Dra. Ana', specialties: [] }]) },
      procedure: {
        findMany: jest.fn().mockResolvedValue([
          { id: PROC_A, base_price: 120, tenant_id: TENANT, name: 'Limpeza', category: 'PROFILAXIA', specialty: null },
          { id: PROC_B, base_price: 80, tenant_id: TENANT, name: 'Flúor', category: 'PROFILAXIA', specialty: null },
        ]),
      },
      paymentGatewayCharge: { findUnique: jest.fn().mockResolvedValue(null) },
      treatmentPlan: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      quote: { findUnique: jest.fn().mockResolvedValue({ status: 'DRAFT' }) },
      auditLog: { create: jest.fn().mockImplementation(async ({ data }: any) => { audits.push(data); return {}; }) },
    };
    const moduleRef: any = { get: jest.fn() };
    const billing: any = {}; // só precisa existir (o approveAndBill é espionado)
    const service = new QuotesService(prisma, moduleRef, undefined, undefined, undefined, undefined, billing);

    jest.spyOn(service as any, 'assertPatientBelongsToTenant').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'ensurePatientReadyForBilling').mockResolvedValue(undefined);
    const create = jest.spyOn(service, 'create').mockResolvedValue({ id: 'q-1', quote_number: 42, total_value: 200 } as any);
    const remove = jest.spyOn(service, 'remove').mockResolvedValue({} as any);
    const approve = jest.spyOn(service, 'approveAndBill').mockResolvedValue({
      quote_id: 'q-1',
      plan_id: 'plan-1',
      charge: { id: 'ch-1', external_id: 'cash-plan-1-AVISTA-1' },
      manual: true,
      receipt: { ok: true, transaction_id: 'tx-1', charge_id: 'ch-1' },
    } as any);
    const rollback = jest.spyOn(service as any, 'rollbackAceite').mockResolvedValue(undefined);
    return { service, prisma, audits, create, remove, approve, rollback };
  }

  const dto = (over: Record<string, unknown> = {}): any => ({
    patient_id: 'p-1',
    dentist_id: DENT,
    items: [{ procedure_id: PROC_A, quantity: 1 }, { procedure_id: PROC_B, quantity: 1 }],
    payments: [{ method: 'DINHEIRO', value: 200 }],
    expected_total: 200,
    client_request_id: KEY,
    ...over,
  });

  it('1. soma das formas diferente do total → 400 e NÃO cria orçamento', async () => {
    const { service, create, approve } = montar();
    const err: any = await service
      .vendaBalcao(TENANT, USER, dto({ payments: [{ method: 'PIX', value: 150 }, { method: 'DINHEIRO', value: 40 }] }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('total da venda');
    expect(create).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('2. dentista fora da clínica → 400 e nada gravado', async () => {
    const { service, create } = montar();
    await expect(service.vendaBalcao(TENANT, USER, dto({ dentist_id: 'outro' }))).rejects.toThrow(
      'Dentista responsável inválido para esta clínica.',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('3. expected_total divergente (preço mudou) → 400 e nada gravado', async () => {
    const { service, create } = montar();
    await expect(
      service.vendaBalcao(TENANT, USER, dto({ expected_total: 180, payments: [{ method: 'DINHEIRO', value: 200 }] })),
    ).rejects.toThrow('O preço de algum procedimento mudou');
    expect(create).not.toHaveBeenCalled();
  });

  it('paciente sem CPF barra ANTES de gravar (sem orçamento órfão)', async () => {
    const { service, create } = montar();
    (service as any).ensurePatientReadyForBilling.mockRejectedValueOnce(new BadRequestException('Paciente sem CPF cadastrado.'));
    await expect(service.vendaBalcao(TENANT, USER, dto())).rejects.toThrow('Paciente sem CPF');
    expect(create).not.toHaveBeenCalled();
  });

  it('4. caminho feliz: approveAndBill com manual_payment_method + 5º argumento; plano auto-liberado com AuditLog', async () => {
    const { service, prisma, audits, create, approve } = montar();
    const r: any = await service.vendaBalcao(TENANT, USER, dto());

    // Orçamento montado no servidor, dentista em todos os itens, notas "Venda rapida ..."
    expect(create).toHaveBeenCalledWith('p-1', TENANT, USER, expect.objectContaining({
      discount_percent: 0,
      notes: 'Venda rapida — recebido na clinica: Espécie',
      items: [
        expect.objectContaining({ procedure_id: PROC_A, dentist_id: DENT }),
        expect.objectContaining({ procedure_id: PROC_B, dentist_id: DENT }),
      ],
    }));
    expect(approve).toHaveBeenCalledWith(
      'q-1', TENANT, USER,
      expect.objectContaining({
        billing_type: 'PIX',
        value: 200,
        manual_payment_method: 'DINHEIRO',
        received_in_clinic: true,
        received_method: 'DINHEIRO',
        quick_sale: true,
      }),
      { payments: undefined, idempotencyKey: KEY, origem: 'venda-balcao' },
    );
    // Auto-liberação só em plano ACTIVE ainda não validado
    expect(prisma.treatmentPlan.updateMany).toHaveBeenCalledWith({
      where: { id: 'plan-1', validated_by_financial_at: null, status: 'ACTIVE' },
      data: { validated_by_financial_at: expect.any(Date), validated_by_financial_id: null },
    });
    const lib = audits.find((a) => a.action === 'AUTO_LIBERADO_BALCAO');
    expect(lib).toBeDefined();
    expect(lib.tenant_id).toBe(TENANT);
    expect(lib.entity).toBe('TREATMENT_PLAN');
    expect(lib.actor_user_id).toBe(USER);
    expect(audits.find((a) => a.action === 'done' && a.entity === 'VENDA_BALCAO')).toBeDefined();

    expect(r).toEqual({
      quote_id: 'q-1',
      quote_number: 42,
      plan_id: 'plan-1',
      total: 200,
      charge_id: 'ch-1',
      external_id: 'cash-plan-1-AVISTA-1',
      transaction_id: 'tx-1',
      auto_validated: true,
    });
  });

  it('2 cartões na maquineta: split com parcelas vai no 5º argumento', async () => {
    const { service, approve } = montar();
    const payments = [
      { method: 'CARTAO', value: 150, installments: 3, debit: false },
      { method: 'CARTAO', value: 50, debit: true },
    ];
    await service.vendaBalcao(TENANT, USER, dto({ payments }));
    expect(approve).toHaveBeenCalledWith(
      'q-1', TENANT, USER,
      expect.objectContaining({ manual_payment_method: 'CARTAO', installment_count: undefined }),
      expect.objectContaining({ payments, idempotencyKey: KEY }),
    );
  });

  it('5. approveAndBill lança → orçamento removido, AuditLog rollback e o erro sobe', async () => {
    const { service, audits, remove, approve, rollback } = montar();
    approve.mockRejectedValueOnce(new BadRequestException('Não foi possível lançar o recebimento no caixa — a venda NÃO foi registrada. Tente de novo.'));
    await expect(service.vendaBalcao(TENANT, USER, dto())).rejects.toThrow('a venda NÃO foi registrada');
    expect(remove).toHaveBeenCalledWith('q-1', TENANT, USER);
    expect(rollback).not.toHaveBeenCalled(); // quote voltou pra DRAFT (o approveAndBill já desfez)
    const rb = audits.find((a) => a.action === 'rollback');
    expect(rb).toBeDefined();
    expect(rb.entity).toBe('VENDA_BALCAO');
    expect(rb.tenant_id).toBe(TENANT);
  });

  it('falha FORA do try interno (quote ficou ACCEPTED) → rollbackAceite do plano antes de remover', async () => {
    const { service, prisma, remove, approve, rollback } = montar();
    approve.mockRejectedValueOnce(new Error('falhou ao ativar o plano'));
    prisma.quote.findUnique.mockResolvedValueOnce({ status: 'ACCEPTED' });
    prisma.treatmentPlan.findFirst.mockResolvedValueOnce({ id: 'plan-x' });
    await expect(service.vendaBalcao(TENANT, USER, dto())).rejects.toThrow('falhou ao ativar o plano');
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({
      quoteId: 'q-1', tenantId: TENANT, priorStatus: 'DRAFT', reverterQuote: true, planId: 'plan-x',
    }));
    expect(remove).toHaveBeenCalled();
  });

  it('6. client_request_id já usado → devolve o resultado com idempotent:true, sem criar nada', async () => {
    const { service, prisma, create, approve } = montar();
    prisma.paymentGatewayCharge.findUnique.mockResolvedValueOnce({
      id: 'ch-1', tenant_id: TENANT, status: 'RECEIVED', external_id: 'cash-plan-1-AVISTA-1',
      transaction_id: 'tx-1', treatment_plan_id: 'plan-1', amount: '200.00',
    });
    prisma.treatmentPlan.findUnique.mockResolvedValueOnce({
      id: 'plan-1', quote_id: 'q-1', validated_by_financial_at: new Date(), quote: { quote_number: 42 },
    });
    const r: any = await service.vendaBalcao(TENANT, USER, dto());
    expect(r).toEqual(expect.objectContaining({
      idempotent: true, quote_id: 'q-1', quote_number: 42, plan_id: 'plan-1', total: 200,
      charge_id: 'ch-1', transaction_id: 'tx-1', auto_validated: true,
    }));
    expect(create).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('chave de OUTRA clínica ou de venda desfeita (CANCELLED) não é reaproveitada', async () => {
    const { service, prisma, create } = montar();
    prisma.paymentGatewayCharge.findUnique.mockResolvedValueOnce({
      id: 'ch-z', tenant_id: 'outro-tenant', status: 'RECEIVED', external_id: 'x', transaction_id: 'tx', treatment_plan_id: null, amount: 200,
    });
    await service.vendaBalcao(TENANT, USER, dto());
    expect(create).toHaveBeenCalledTimes(1);

    const m2 = montar();
    m2.prisma.paymentGatewayCharge.findUnique.mockResolvedValueOnce({
      id: 'ch-c', tenant_id: TENANT, status: 'CANCELLED', external_id: 'y', transaction_id: null, treatment_plan_id: null, amount: 200,
    });
    await m2.service.vendaBalcao(TENANT, USER, dto());
    expect(m2.create).toHaveBeenCalledTimes(1);
  });

  it('corrida com a mesma chave (VENDA_DUPLICADA) → desfaz a sua e devolve a venda que entrou', async () => {
    const { service, prisma, remove, approve } = montar();
    approve.mockRejectedValueOnce(new ConflictException({ message: 'Venda já registrada', code: 'VENDA_DUPLICADA' }));
    prisma.paymentGatewayCharge.findUnique
      .mockResolvedValueOnce(null) // 1ª checagem (antes de gravar): ainda não existia
      .mockResolvedValue({
        id: 'ch-0', tenant_id: TENANT, status: 'RECEIVED', external_id: 'cash-plan-0-AVISTA-1',
        transaction_id: 'tx-0', treatment_plan_id: 'plan-0', amount: 200,
      });
    prisma.treatmentPlan.findUnique.mockResolvedValue({
      id: 'plan-0', quote_id: 'q-0', validated_by_financial_at: new Date(), quote: { quote_number: 41 },
    });
    const r: any = await service.vendaBalcao(TENANT, USER, dto());
    expect(remove).toHaveBeenCalledWith('q-1', TENANT, USER); // a nossa (perdedora) some
    expect(r).toEqual(expect.objectContaining({ idempotent: true, quote_id: 'q-0', charge_id: 'ch-0' }));
  });

  it('erro DEPOIS da receita desta venda → mantém a venda (não desfaz nem cobra de novo)', async () => {
    const { service, prisma, remove, approve } = montar();
    approve.mockRejectedValueOnce(new Error('aviso falhou'));
    prisma.paymentGatewayCharge.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'ch-1', tenant_id: TENANT, status: 'RECEIVED', external_id: 'cash-plan-1-AVISTA-1',
        transaction_id: 'tx-1', treatment_plan_id: 'plan-1', amount: 200,
      });
    prisma.treatmentPlan.findUnique.mockResolvedValue({
      id: 'plan-1', quote_id: 'q-1', validated_by_financial_at: null, quote: { quote_number: 42 },
    });
    const r: any = await service.vendaBalcao(TENANT, USER, dto());
    expect(remove).not.toHaveBeenCalled();
    expect(r).toEqual(expect.objectContaining({ quote_id: 'q-1', transaction_id: 'tx-1', idempotent: true }));
  });

  it('7. receipt sem transaction_id → NÃO auto-libera (cai no Validar do Financeiro)', async () => {
    const { service, prisma, audits, approve } = montar();
    approve.mockResolvedValueOnce({
      quote_id: 'q-1', plan_id: 'plan-1', charge: { id: 'ch-1', external_id: 'e' }, receipt: { ok: true },
    } as any);
    const r: any = await service.vendaBalcao(TENANT, USER, dto());
    expect(prisma.treatmentPlan.updateMany).not.toHaveBeenCalled();
    expect(audits.find((a) => a.action === 'AUTO_LIBERADO_BALCAO')).toBeUndefined();
    expect(r.auto_validated).toBe(false);
    expect(r.transaction_id).toBeNull();
  });

  it('preço abaixo da tabela → venda vale, mas NÃO auto-libera e grava VENDA_VALOR_ABAIXO_ESPERADO no Financeiro', async () => {
    const { service, prisma, audits, approve, create } = montar();
    create.mockResolvedValueOnce({ id: 'q-1', quote_number: 42, total_value: 81 } as any);
    const r: any = await service.vendaBalcao(TENANT, USER, dto({
      items: [{ procedure_id: PROC_A, quantity: 1, unit_price: 1 }, { procedure_id: PROC_B, quantity: 1 }],
      payments: [{ method: 'DINHEIRO', value: 81 }],
      expected_total: 81,
    }));
    expect(approve).toHaveBeenCalled();
    expect(prisma.treatmentPlan.updateMany).not.toHaveBeenCalled();
    expect(audits.find((a) => a.action === 'AUTO_LIBERADO_BALCAO')).toBeUndefined();
    expect(r.auto_validated).toBe(false);
    const abaixo = audits.find((a) => a.action === 'VENDA_VALOR_ABAIXO_ESPERADO');
    expect(abaixo).toMatchObject({ tenant_id: TENANT, actor_user_id: USER, entity: 'FINANCEIRO', entity_id: 'q-1' });
    expect(abaixo.meta_json).toMatchObject({
      valor: 81,
      esperado_min: 200,
      origem: 'venda-balcao',
      plan_id: 'plan-1',
      itens: [{ procedure_id: PROC_A, quantity: 1, tabela: 120, vendido: 1 }],
    });
    expect(abaixo.meta_json.descricao).toContain('tabela R$ 200.00');
    expect(audits.find((a) => a.action === 'done').meta_json).toMatchObject({ tabela: 200, abaixo_tabela: true });
  });

  it('preço de tabela → sem registro de "abaixo do esperado"', async () => {
    const { service, audits } = montar();
    await service.vendaBalcao(TENANT, USER, dto());
    expect(audits.find((a) => a.action === 'VENDA_VALOR_ABAIXO_ESPERADO')).toBeUndefined();
  });

  it('plano já validado (updateMany count 0) → auto_validated false, sem AuditLog de liberação', async () => {
    const { service, prisma, audits } = montar();
    prisma.treatmentPlan.updateMany.mockResolvedValueOnce({ count: 0 });
    const r: any = await service.vendaBalcao(TENANT, USER, dto());
    expect(r.auto_validated).toBe(false);
    expect(audits.find((a) => a.action === 'AUTO_LIBERADO_BALCAO')).toBeUndefined();
  });

  it('I3: approveAndBill REAL repassa o 5º argumento ao createManualReceipt e devolve a ConflictException inalterada', async () => {
    const prisma: any = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      treatmentPlan: { findFirst: jest.fn().mockResolvedValue({ id: 'plan-1', status: 'ACTIVE' }) },
    };
    const conflito = new ConflictException({ message: 'Venda já registrada', code: 'VENDA_DUPLICADA' });
    const billing: any = { createManualReceipt: jest.fn().mockRejectedValue(conflito) };
    const service = new QuotesService(prisma, { get: jest.fn() } as any, undefined, undefined, undefined, undefined, billing);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'q-1', status: 'DRAFT', patient_id: 'p-1', total_value: 200, items: [] } as any);
    jest.spyOn(service as any, 'ensurePatientReadyForBilling').mockResolvedValue(undefined);
    jest.spyOn(service, 'accept').mockResolvedValue({} as any);
    const rollback = jest.spyOn(service as any, 'rollbackAceite').mockResolvedValue(undefined);
    const payments = [{ method: 'PIX', value: 120 }, { method: 'DINHEIRO', value: 80 }];

    const err = await service
      .approveAndBill(
        'q-1', TENANT, USER,
        { billing_type: 'PIX', value: 200, manual_payment_method: 'PIX', received_in_clinic: true, quick_sale: true },
        { payments, idempotencyKey: KEY, origem: 'venda-balcao' },
      )
      .catch((e) => e);

    expect(err).toBe(conflito);
    expect(billing.createManualReceipt).toHaveBeenCalledWith('plan-1', TENANT, expect.objectContaining({
      value: 200, paymentMethod: 'PIX', receiveNow: true, payments, idempotencyKey: KEY, origem: 'venda-balcao',
    }));
    // A venda perdedora desfaz o aceite/plano dela (rollbackAceite com o plano criado aqui).
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({ quoteId: 'q-1', planId: 'plan-1', reverterQuote: true }));
  });

  it('E2: approveAndBill não executa itens (nem com o campo antigo vindo do front em cache)', async () => {
    const prisma: any = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      treatmentPlan: { findFirst: jest.fn().mockResolvedValue({ id: 'plan-1', status: 'ACTIVE' }) },
      commission: { findFirst: jest.fn().mockResolvedValue({ id: 'ja-tem' }) },
      globalSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      quote: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const treatmentPlans: any = { autoExecutePlanItems: jest.fn() };
    const billing: any = { createManualReceipt: jest.fn().mockResolvedValue({ plan_id: 'plan-1', charge: { id: 'c' }, receipt: { ok: true } }) };
    const service = new QuotesService(
      prisma, { get: jest.fn() } as any, undefined, undefined, undefined, undefined, billing,
      undefined, undefined, treatmentPlans,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'q-1', status: 'ACCEPTED', patient_id: 'p-1', total_value: 200, items: [], patient: {} } as any);
    jest.spyOn(service as any, 'ensurePatientReadyForBilling').mockResolvedValue(undefined);
    await service.approveAndBill('q-1', TENANT, USER, {
      billing_type: 'PIX', value: 200, manual_payment_method: 'DINHEIRO', received_in_clinic: true,
      // front antigo em cache
      ...({ auto_execute_items: true, executed_by_dentist_id: DENT } as any),
    });
    expect(treatmentPlans.autoExecutePlanItems).not.toHaveBeenCalled();
  });

  it('total do orçamento gravado diverge do calculado → remove e 400', async () => {
    const { service, create, remove, approve } = montar();
    create.mockResolvedValueOnce({ id: 'q-9', quote_number: 9, total_value: 190 } as any);
    await expect(service.vendaBalcao(TENANT, USER, dto())).rejects.toThrow('Total divergente');
    expect(remove).toHaveBeenCalledWith('q-9', TENANT, USER);
    expect(approve).not.toHaveBeenCalled();
  });
});
