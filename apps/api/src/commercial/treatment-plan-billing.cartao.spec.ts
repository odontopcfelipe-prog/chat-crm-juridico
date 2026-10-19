import { BadRequestException, ConflictException } from '@nestjs/common';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';

/**
 * Venda no CARTÃO da maquineta (decisão do dono, 17/out/2026): o cartão é passado NA
 * HORA → entra como RECEBIDO (receita CARTAO), sem Asaas, sem parcelas, sem "a receber"
 * que vence. Antes: cartão parcelado no Asaas (parcelas com link vencendo e cobrando) e
 * depois "a receber" que ficava atrasado.
 */
describe('TreatmentPlanBillingService — venda no cartão (maquineta)', () => {
  const TENANT = 't1';
  function montar() {
    const created: any[] = [];
    const prisma: any = {
      treatmentPlan: {
        findUnique: jest.fn().mockResolvedValue({ id: 'plan1', patient_id: 'pat1', status: 'ACTIVE', patient: { id: 'pat1', tenant_id: TENANT, name: 'Paloma Freire' } }),
      },
      paymentGatewayCharge: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => { created.push(data); return { id: 'ch1', ...data }; }),
        // Fase 0 — compensação do createManualReceipt (relê transaction_id / cancela).
        findUnique: jest.fn().mockResolvedValue({ transaction_id: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const paymentGateway: any = {
      registerClinicReceipt: jest.fn().mockResolvedValue({ ok: true }),
      ensureCustomerForPatient: jest.fn(),
    };
    const asaas: any = {
      createCharge: jest.fn(),
      // Fase 0 — E4: conta Asaas CONFIGURADA e própria; mesmo assim o balcão fica local.
      isConfigured: jest.fn().mockResolvedValue(true),
      hasOwnAccount: jest.fn().mockResolvedValue(true),
    };
    const svc = new TreatmentPlanBillingService(prisma, paymentGateway, asaas);
    return { svc, created, paymentGateway, asaas, prisma };
  }

  it('cartão 3x recebido na hora: 1 cobrança local CARTAO, receita no caixa com as 3x, nada no Asaas', async () => {
    const { svc, created, paymentGateway, asaas } = montar();
    await svc.createManualReceipt('plan1', TENANT, { value: 700, paymentMethod: 'CARTAO', receiveNow: true, installments: 3 });

    expect(created).toHaveLength(1);
    expect(created[0].gateway).toBe('CASH');
    expect(created[0].kind).toBeUndefined(); // não é SINAL/ENTRADA/INSTALLMENT
    expect(created[0].external_id).toContain('-CARTAO-');
    expect(created[0].patient_id).toBe('pat1'); // a ficha do paciente acha a cobrança (sem isso: "SEM COBRANÇA")
    expect(created[0].description).toContain('cartão 3x na maquineta · recebido na clínica');
    expect(paymentGateway.registerClinicReceipt).toHaveBeenCalledWith(
      created[0].external_id,
      expect.objectContaining({ paymentMethod: 'CARTAO', installments: 3 }),
    );
    expect(asaas.createCharge).not.toHaveBeenCalled();
  });

  it('PIX na maquininha continua igual (recebido, marcador AVISTA, sem nº de parcelas)', async () => {
    const { svc, created, paymentGateway } = montar();
    await svc.createManualReceipt('plan1', TENANT, { value: 100, paymentMethod: 'PIX_MAQUININHA', receiveNow: true });
    expect(created[0].external_id).toContain('-AVISTA-');
    expect(created[0].description).toContain('(recebido na clínica)');
    expect(paymentGateway.registerClinicReceipt).toHaveBeenCalledWith(
      created[0].external_id,
      expect.objectContaining({ paymentMethod: 'PIX_MAQUININHA', installments: undefined }),
    );
  });

  // ─── Fase 0 — E4: "recebido na clínica" é SEMPRE local ──────────────────────
  it('E4: recebido na clínica com Asaas configurado → cobrança LOCAL, sem customer nem charge no Asaas', async () => {
    const { svc, created, paymentGateway, asaas } = montar();
    const r: any = await svc.createSimpleCharge('plan1', TENANT, { billingType: 'PIX', value: 150, receivedInClinic: true });
    expect(paymentGateway.ensureCustomerForPatient).not.toHaveBeenCalled();
    expect(asaas.createCharge).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
    expect(created[0].gateway).toBe('CASH');
    expect(created[0].external_id).toMatch(/^local-plan1-/);
    expect(r.pix).toBeNull();
  });

  // ─── Fase 0 — I2: split, idempotência e compensação ─────────────────────────
  it('I2: payments[] chega ao registerClinicReceipt, grava idempotency_key e a origem', async () => {
    const { svc, created, paymentGateway } = montar();
    const payments = [
      { method: 'CARTAO', value: 60, installments: 3, debit: false },
      { method: 'CARTAO', value: 40, debit: true },
    ];
    await svc.createManualReceipt('plan1', TENANT, {
      value: 100, paymentMethod: 'CARTAO', receiveNow: true, userId: 'u1',
      payments, idempotencyKey: '11111111-1111-4111-8111-111111111111', origem: 'venda-balcao',
    });
    expect(created[0].idempotency_key).toBe('11111111-1111-4111-8111-111111111111');
    // 2 cartões = venda no cartão → marcador -CARTAO-
    expect(created[0].external_id).toContain('-CARTAO-');
    expect(paymentGateway.registerClinicReceipt).toHaveBeenCalledWith(
      created[0].external_id,
      expect.objectContaining({ payments, origem: 'venda-balcao', userId: 'u1' }),
    );
  });

  it('I2: formas MISTAS (cartão dominante) não levam o marcador -CARTAO- e a descrição diz "N formas"', async () => {
    const { svc, created } = montar();
    await svc.createManualReceipt('plan1', TENANT, {
      value: 100, paymentMethod: 'CARTAO', receiveNow: true,
      payments: [{ method: 'CARTAO', value: 70 }, { method: 'DINHEIRO', value: 30 }],
    });
    expect(created[0].external_id).toContain('-AVISTA-');
    expect(created[0].description).toContain('recebido na clínica · 2 formas');
    expect(created[0].idempotency_key).toBeNull();
  });

  it('I2: sem origem explícita o rastro diz approve-and-bill', async () => {
    const { svc, paymentGateway } = montar();
    await svc.createManualReceipt('plan1', TENANT, { value: 100, paymentMethod: 'DINHEIRO', receiveNow: true });
    expect(paymentGateway.registerClinicReceipt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ origem: 'approve-and-bill' }),
    );
  });

  it('I2: soma das formas diferente do valor → 400 ANTES de criar a cobrança', async () => {
    const { svc, prisma, paymentGateway } = montar();
    await expect(
      svc.createManualReceipt('plan1', TENANT, {
        value: 100, paymentMethod: 'PIX', receiveNow: true,
        payments: [{ method: 'PIX', value: 50 }, { method: 'DINHEIRO', value: 40 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.paymentGatewayCharge.create).not.toHaveBeenCalled();
    expect(paymentGateway.registerClinicReceipt).not.toHaveBeenCalled();
  });

  it('I2: caixa falhou e NÃO há receita → cobrança vira CANCELLED com rastro e a venda dá erro', async () => {
    const { svc, prisma, paymentGateway } = montar();
    paymentGateway.registerClinicReceipt.mockRejectedValueOnce(new Error('deadlock'));
    await expect(
      svc.createManualReceipt('plan1', TENANT, {
        value: 100, paymentMethod: 'DINHEIRO', receiveNow: true, userId: 'u1',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toThrow('a venda NÃO foi registrada');
    expect(prisma.paymentGatewayCharge.update).toHaveBeenCalledTimes(1);
    const { where, data } = prisma.paymentGatewayCharge.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'ch1' });
    expect(data).toEqual(expect.objectContaining({
      status: 'CANCELLED',
      received_in_cash: false,
      received_at: null,
      paid_at: null,
      idempotency_key: null, // libera a chave: o retry pode tentar de novo
      cancelled_by_user_id: 'u1',
      cancel_reason: 'Falha ao lançar no caixa — venda desfeita automaticamente',
    }));
    expect(data.cancelled_at).toBeInstanceOf(Date);
  });

  it('I2: caixa recusou por regra (400) → cancela e devolve a MENSAGEM ORIGINAL', async () => {
    const { svc, prisma, paymentGateway } = montar();
    paymentGateway.registerClinicReceipt.mockRejectedValueOnce(new BadRequestException('Esta cobrança está cancelada/estornada — não pode receber baixa.'));
    await expect(
      svc.createManualReceipt('plan1', TENANT, { value: 100, paymentMethod: 'DINHEIRO', receiveNow: true }),
    ).rejects.toThrow('Esta cobrança está cancelada/estornada');
    expect(prisma.paymentGatewayCharge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
  });

  it('I2: receipt ok:false (cobrança não achada) também desfaz', async () => {
    const { svc, prisma, paymentGateway } = montar();
    paymentGateway.registerClinicReceipt.mockResolvedValueOnce({ ok: false, reason: 'charge_not_found' });
    await expect(
      svc.createManualReceipt('plan1', TENANT, { value: 100, paymentMethod: 'PIX', receiveNow: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.paymentGatewayCharge.update).toHaveBeenCalledTimes(1);
  });

  it('I2: caixa lançou erro mas a receita JÁ entrou (transaction_id) → sucesso, nada é cancelado', async () => {
    const { svc, prisma, paymentGateway } = montar();
    paymentGateway.registerClinicReceipt.mockRejectedValueOnce(new Error('comissão falhou'));
    prisma.paymentGatewayCharge.findUnique.mockResolvedValueOnce({ transaction_id: 'tx9' });
    const r: any = await svc.createManualReceipt('plan1', TENANT, { value: 100, paymentMethod: 'DINHEIRO', receiveNow: true });
    expect(r.receipt).toEqual({ ok: true, transaction_id: 'tx9', charge_id: 'ch1' });
    expect(prisma.paymentGatewayCharge.update).not.toHaveBeenCalled();
  });

  it('I2: P2002 na idempotency_key → ConflictException com code VENDA_DUPLICADA', async () => {
    const { svc, prisma, paymentGateway } = montar();
    prisma.paymentGatewayCharge.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['idempotency_key'] } }),
    );
    const err: any = await svc
      .createManualReceipt('plan1', TENANT, {
        value: 100, paymentMethod: 'DINHEIRO', receiveNow: true,
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(expect.objectContaining({ code: 'VENDA_DUPLICADA' }));
    expect(paymentGateway.registerClinicReceipt).not.toHaveBeenCalled();
  });

  it('I2: P2002 SEM chave de idempotência continua sendo o erro do banco', async () => {
    const { svc, prisma } = montar();
    prisma.paymentGatewayCharge.create.mockRejectedValueOnce(Object.assign(new Error('Unique'), { code: 'P2002' }));
    const err: any = await svc
      .createManualReceipt('plan1', TENANT, { value: 100, paymentMethod: 'DINHEIRO', receiveNow: true })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(ConflictException);
    expect(err.code).toBe('P2002');
  });
});
