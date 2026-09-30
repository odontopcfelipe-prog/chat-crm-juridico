import { QuotesService } from './quotes.service';

/**
 * BLINDAGEM — Proposta À VISTA PIX (o fluxo que o dono validou funcionando).
 *
 * Trava o comportamento VISÍVEL da negociação aprovada quando a venda é à vista PIX:
 *  1. usa o template À VISTA (negociacao_aprovada_avista) → NÃO fala em "boleto"
 *     nem promete "amanhã os boletos" (o paciente paga por PIX agora);
 *  2. NÃO grava a âncora BOLETO_INTRO (à vista não tem boleto pra entregar/apresentar);
 *  3. inclui a instrução de PIX ("código PIX").
 *
 * Se um refactor futuro voltar a mandar o texto de boleto numa venda à vista, ou
 * re-ancorar boletos, ESTE TESTE QUEBRA — de propósito.
 */
describe('QuotesService — proposta à vista PIX (blindagem)', () => {
  const TENANT = '00000000-0000-0000-0000-000000000000';
  const PLAN = 'plan-avista-1';

  function buildService() {
    const auditCreate = jest.fn().mockResolvedValue({});
    const dispatchCreate = jest.fn().mockResolvedValue({});
    const sendText = jest.fn().mockResolvedValue({ key: { id: 'wamid-1' } });

    const prisma: any = {
      globalSetting: {
        // Disparo ligado (à vista herda/usa o enable); template não customizado → default.
        findUnique: jest.fn().mockImplementation(({ where: { key } }: any) => {
          if (String(key).startsWith('NEGOCIACAO_APROVADA')) return { value: 'true' };
          return null; // template keys, etc. → usa o default do @crm/shared
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null), // dedup: ainda não enviada
        create: auditCreate,
      },
      dispatchLog: { create: dispatchCreate },
      tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Instituto Odonto Passos' }) },
      treatmentPlanItem: {
        findMany: jest.fn().mockResolvedValue([{ quantity: 1, procedure: { name: 'Lente de Porcelana' } }]),
      },
      treatmentPlan: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    const whatsapp: any = {
      getInstanceForPurpose: jest.fn().mockResolvedValue('chip-financeiro'),
      sendText,
      sendMedia: jest.fn().mockResolvedValue({ key: { id: 'wamid-pdf' } }),
    };
    const moduleRef: any = { get: jest.fn() };

    // Instanciação direta (constructor tem muitos @Optional): passamos só o necessário.
    // Ordem: (prisma, moduleRef, whatsapp, portalAuth, versions, contractService,
    //         billingService, contractsService, pdfService, treatmentPlans, fechamentoQueue)
    const service = new QuotesService(
      prisma, moduleRef, whatsapp,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    );
    return { service, prisma, whatsapp, auditCreate, dispatchCreate, sendText };
  }

  it('à vista PIX: usa o template À VISTA, sem falar em boleto e sem ancorar boleto', async () => {
    const { service, whatsapp, auditCreate, sendText } = buildService();

    await (service as any).sendNegociacaoAprovada(
      TENANT,
      PLAN,
      { name: 'Gustavo Henrique', phone: '5582999990000' },
      { total: 1500, forma: 'PIX' }, // à vista: sem entrada, sem parcelas
    );

    // Mandou a negociação ao paciente.
    expect(sendText).toHaveBeenCalledTimes(1);
    const msg = String(sendText.mock.calls[0][1]);

    // NÃO fala em boleto (nem "amanhã os boletos").
    expect(msg.toLowerCase()).not.toContain('boleto');
    // Instrução de PIX presente.
    expect(msg).toContain('código PIX');

    // NUNCA gravou a âncora BOLETO_INTRO (à vista não tem boleto pra apresentar/entregar).
    const ancorouBoleto = auditCreate.mock.calls.some(
      (c: any[]) => c?.[0]?.data?.entity === 'BOLETO_INTRO',
    );
    expect(ancorouBoleto).toBe(false);

    // Saiu pelo chip Financeiro (com fallback Clínica).
    expect(whatsapp.getInstanceForPurpose).toHaveBeenCalledWith(TENANT, 'FINANCEIRO');
  });

  it('boleto/parcelado: usa o template PARCELADO (condições entrada+parcelas), SEM a instrução de PIX — garante que a blindagem à vista não invade o financiamento', async () => {
    const { service, sendText } = buildService();

    await (service as any).sendNegociacaoAprovada(
      TENANT,
      PLAN,
      { name: 'Maria', phone: '5582988880000' },
      { entrada: 2000, parcelas: 12, valorParcela: 1000, total: 14000, forma: 'BOLETO' },
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    const msg = String(sendText.mock.calls[0][1]);
    // Mostra as condições do parcelamento (entrada + Nx), não o texto à vista.
    expect(msg).toContain('Entrada');
    expect(msg).toContain('12x');
    // NÃO usa a instrução de PIX à vista (essa é exclusiva da venda à vista).
    expect(msg).not.toContain('código PIX');
  });
});
