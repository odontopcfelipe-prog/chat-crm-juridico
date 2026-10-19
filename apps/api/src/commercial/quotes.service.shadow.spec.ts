import { BadRequestException } from '@nestjs/common';
import { QuotesService } from './quotes.service';

/**
 * Fase 0 — E1: approve-and-bill em MODO SOMBRA. Valor cobrado ABAIXO do orçamento
 * (itens aprovados ou total, menos o desconto à vista) vira um AuditLog FINANCEIRO
 * (aparece na aba Log) — sem bloquear a venda e sem WhatsApp. Juros só aumentam.
 */
describe('QuotesService — approve-and-bill em modo sombra (Fase 0)', () => {
  const TENANT = 't-sombra';
  const USER = 'u-vendedor';

  function montar() {
    const auditCreate = jest.fn().mockResolvedValue({});
    const prisma: any = {
      auditLog: { create: auditCreate },
      treatmentPlan: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const moduleRef: any = { get: jest.fn() };
    // (prisma, moduleRef, whatsapp, portalAuth, versions, contractService, billingService, ...)
    const billing: any = {};
    const service = new QuotesService(prisma, moduleRef, undefined, undefined, undefined, undefined, billing);
    return { service, prisma, auditCreate };
  }

  const quoteBase = (over: Record<string, unknown> = {}) => ({
    id: 'q-1',
    status: 'DRAFT',
    patient_id: 'p-1',
    total_value: 1000,
    avista_discount_enabled: false,
    avista_discount_pct: 0,
    items: [
      { id: 'i1', total_price: 600, approved_at: null },
      { id: 'i2', total_price: 400, approved_at: null },
    ],
    ...over,
  });

  const check = (service: QuotesService, quote: any, value: number) =>
    (service as any).shadowCheckApproveValue(quote, TENANT, USER, { value, billing_type: 'PIX' });

  it('valor ABAIXO do orçamento grava AuditLog FINANCEIRO (com tenant na coluna) e não lança', async () => {
    const { service, auditCreate } = montar();
    await expect(check(service, quoteBase(), 800)).resolves.toBeUndefined();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const { data } = auditCreate.mock.calls[0][0];
    expect(data.tenant_id).toBe(TENANT);
    expect(data.actor_user_id).toBe(USER);
    expect(data.entity).toBe('FINANCEIRO');
    expect(data.entity_id).toBe('q-1');
    expect(data.action).toBe('VENDA_VALOR_ABAIXO_ESPERADO');
    expect(data.meta_json.valor).toBe(800);
    expect(data.meta_json.esperado_min).toBe(1000);
    expect(String(data.meta_json.descricao)).toContain('abaixo do orçamento');
  });

  it('valor IGUAL ou ACIMA (juros) não grava nada', async () => {
    const { service, auditCreate } = montar();
    await check(service, quoteBase(), 1000);
    await check(service, quoteBase(), 1180.5);
    // 1 centavo de tolerância (arredondamento)
    await check(service, quoteBase(), 999.99);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('à vista de 5%: valor = base × 0,95 não grava; abaixo disso grava', async () => {
    const { service, auditCreate } = montar();
    const q = quoteBase({ avista_discount_enabled: true, avista_discount_pct: '5.00' });
    await check(service, q, 950);
    expect(auditCreate).not.toHaveBeenCalled();
    await check(service, q, 940);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data.meta_json.avista_pct).toBe(5);
  });

  it('desconto à vista DESLIGADO ignora o % gravado', async () => {
    const { service, auditCreate } = montar();
    await check(service, quoteBase({ avista_discount_enabled: false, avista_discount_pct: 5 }), 950);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('aprovação parcial: a base é a soma dos itens aprovados', async () => {
    const { service, auditCreate } = montar();
    const q = quoteBase({
      items: [
        { id: 'i1', total_price: 600, approved_at: new Date() },
        { id: 'i2', total_price: 400, approved_at: null },
      ],
    });
    await check(service, q, 600);
    expect(auditCreate).not.toHaveBeenCalled();
    await check(service, q, 500);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data.meta_json.parcial).toBe(true);
  });

  it('falha do prisma não propaga (modo sombra nunca bloqueia)', async () => {
    const { service, auditCreate } = montar();
    auditCreate.mockRejectedValueOnce(new Error('db fora'));
    await expect(check(service, quoteBase(), 100)).resolves.toBeUndefined();
  });

  it('approveAndBill chama o modo sombra logo depois de validar o paciente', async () => {
    const { service, auditCreate } = montar();
    jest.spyOn(service, 'findOne').mockResolvedValue(quoteBase({ status: 'ACCEPTED' }) as any);
    jest.spyOn(service as any, 'ensurePatientReadyForBilling').mockResolvedValue(undefined);
    // Sem plano o fluxo para logo depois (400) — o registro da sombra já foi feito.
    await expect(
      service.approveAndBill('q-1', TENANT, USER, { billing_type: 'PIX', value: 500 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'VENDA_VALOR_ABAIXO_ESPERADO', tenant_id: TENANT }) }),
    );
  });
});
