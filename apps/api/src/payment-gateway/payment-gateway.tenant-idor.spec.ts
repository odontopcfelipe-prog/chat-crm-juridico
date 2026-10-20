/**
 * Fase 0.1 — isolamento entre clínicas (anti-IDOR) nas rotas por id do
 * payment-gateway que ainda não conferiam o tenant:
 *   - POST/GET installments/:id/charge (cobrança da parcela);
 *   - POST charges (leadHonorarioPaymentId) e POST charges/installment;
 *   - POST customers/sync/:leadId, POST customers/link, DELETE customers/:id;
 *   - POST boleto-delivery/test e boleto-delivery/send-current (plan_id).
 * Id de outra clínica → 404, sem ler/gravar nada nem bater no Asaas/WhatsApp.
 * Na própria clínica, o comportamento segue igual.
 */
import { NotFoundException } from '@nestjs/common';
import { PaymentGatewayService } from './payment-gateway.service';
import { PaymentGatewayController } from './payment-gateway.controller';
import { BoletoDeliveryService } from './boleto-delivery.service';

const A = 'tenant-a';
const B = 'tenant-b';

function montarService(prisma: any, asaas: any = {}) {
  const svc = new PaymentGatewayService(
    prisma, asaas, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return svc;
}

describe('createChargeForInstallment — parcela de outra clínica', () => {
  function montar() {
    const prisma: any = {
      installment: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === 'inst-a' && where.tenant_id === A ? { id: 'inst-a' } : null),
      },
      paymentGatewayCharge: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ch-a', tenant_id: A, external_id: 'pay_a', pix_qr_code: 'qr', pix_copy_paste: 'copia-e-cola',
          pix_expiration_date: null, boleto_url: null, boleto_barcode: null,
        }),
      },
    };
    return { svc: montarService(prisma), prisma };
  }

  it('404 ANTES da idempotência — não devolve o PIX da outra clínica', async () => {
    const { svc, prisma } = montar();
    await expect(svc.createChargeForInstallment('inst-a', 'PIX', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCharge.findUnique).not.toHaveBeenCalled();
  });

  it('na própria clínica a idempotência devolve a cobrança existente', async () => {
    const { svc } = montar();
    const r: any = await svc.createChargeForInstallment('inst-a', 'PIX', A);
    expect(r.external_id).toBe('pay_a');
    expect(r.pix.copyPaste).toBe('copia-e-cola');
  });
});

describe('getInstallmentChargeDetails — cobrança de outra clínica', () => {
  it('404 e não consulta o Asaas', async () => {
    const asaas: any = { getCharge: jest.fn() };
    const prisma: any = {
      paymentGatewayCharge: { findUnique: jest.fn().mockResolvedValue({ id: 'ch-a', tenant_id: A, external_id: 'pay_a' }) },
    };
    const svc = montarService(prisma, asaas);
    await expect(svc.getInstallmentChargeDetails('inst-a', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(asaas.getCharge).not.toHaveBeenCalled();
  });
});

describe('createChargeForLeadPayment (POST charges) — honorário de outra clínica', () => {
  function montar(o: { existing?: any } = {}) {
    const asaas: any = { createCharge: jest.fn(), createCustomer: jest.fn(), getCustomer: jest.fn() };
    const prisma: any = {
      paymentGatewayCharge: { findUnique: jest.fn().mockResolvedValue(o.existing ?? null), create: jest.fn() },
      leadHonorarioPayment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lhp-a', amount: 100, due_date: null,
          lead_honorario: { tenant_id: A, type: 'CONTRATUAL', lead: { id: 'lead-a', name: 'Fulano', tenant_id: A } },
        }),
      },
      lead: { findUnique: jest.fn() },
      paymentGatewayCustomer: { findFirst: jest.fn() },
    };
    return { svc: montarService(prisma, asaas), prisma, asaas };
  }

  it('cobrança já existente de outra clínica → 404 (não devolve a cobrança dela)', async () => {
    const { svc } = montar({ existing: { id: 'ch-a', tenant_id: A, external_id: 'pay_a' } });
    await expect(svc.createChargeForLeadPayment('lhp-a', 'PIX', B)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pagamento de outra clínica → 404, sem criar cliente/cobrança no Asaas', async () => {
    const { svc, asaas, prisma } = montar();
    await expect(svc.createChargeForLeadPayment('lhp-a', 'PIX', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.findUnique).not.toHaveBeenCalled();
    expect(asaas.createCustomer).not.toHaveBeenCalled();
    expect(asaas.createCharge).not.toHaveBeenCalled();
  });

  it('na própria clínica a cobrança existente volta como antes', async () => {
    const { svc } = montar({ existing: { id: 'ch-a', tenant_id: A, external_id: 'pay_a' } });
    const r: any = await svc.createChargeForLeadPayment('lhp-a', 'PIX', A);
    expect(r.external_id).toBe('pay_a');
  });
});

describe('createInstallmentCharge (POST charges/installment) — honorário de outra clínica', () => {
  it('404 sem consultar cobranças nem o Asaas', async () => {
    const asaas: any = { createCharge: jest.fn(), createCustomer: jest.fn() };
    const prisma: any = {
      leadHonorario: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lh-a', tenant_id: A, type: 'CONTRATUAL',
          lead: { id: 'lead-a', name: 'Fulano', tenant_id: A },
          payments: [{ id: 'p1', amount: 100, due_date: null }],
        }),
      },
      paymentGatewayCharge: { findMany: jest.fn() },
    };
    const svc = montarService(prisma, asaas);
    await expect(svc.createInstallmentCharge('lh-a', 'BOLETO', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCharge.findMany).not.toHaveBeenCalled();
    expect(asaas.createCharge).not.toHaveBeenCalled();
  });

  it('legado sem tenant no honorário cai no tenant do lead', async () => {
    const prisma: any = {
      leadHonorario: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lh-a', tenant_id: null, type: 'CONTRATUAL',
          lead: { id: 'lead-a', name: 'Fulano', tenant_id: A },
          payments: [{ id: 'p1', amount: 100, due_date: null }],
        }),
      },
      paymentGatewayCharge: { findMany: jest.fn() },
    };
    const svc = montarService(prisma);
    await expect(svc.createInstallmentCharge('lh-a', 'BOLETO', B)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ensureCustomer (POST customers/sync/:leadId) — lead de outra clínica', () => {
  function montar(existing: any = null) {
    const asaas: any = {
      createCustomer: jest.fn().mockResolvedValue({ id: 'cus_novo' }),
      getCustomer: jest.fn().mockResolvedValue({ id: 'cus_a' }),
    };
    const prisma: any = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead-a', name: 'Fulano', phone: '82999990000', email: null, cpf_cnpj: '12345678900', tenant_id: A,
        }),
      },
      paymentGatewayCustomer: {
        findFirst: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    return { svc: montarService(prisma, asaas), prisma, asaas };
  }

  it('404 antes de qualquer coisa — não cria cliente com o CPF alheio', async () => {
    const { svc, prisma, asaas } = montar();
    await expect(svc.ensureCustomer('lead-a', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCustomer.findFirst).not.toHaveBeenCalled();
    expect(asaas.createCustomer).not.toHaveBeenCalled();
    expect(prisma.paymentGatewayCustomer.create).not.toHaveBeenCalled();
  });

  it('na própria clínica reusa o cliente existente como antes', async () => {
    const { svc, asaas } = montar({ id: 'pgc-a', tenant_id: A, external_id: 'cus_a' });
    const r: any = await svc.ensureCustomer('lead-a', A);
    expect(r.external_id).toBe('cus_a');
    expect(asaas.createCustomer).not.toHaveBeenCalled();
  });
});

describe('linkCustomerToLead (POST customers/link) — lead de outra clínica', () => {
  function montar(leadTenant: string | null) {
    const asaas: any = { getCustomer: jest.fn().mockResolvedValue({ id: 'cus_x', cpfCnpj: '123.456.789-00' }) };
    const prisma: any = {
      lead: { findUnique: jest.fn().mockResolvedValue({ id: 'lead-a', tenant_id: leadTenant }), updateMany: jest.fn() },
      paymentGatewayCustomer: { create: jest.fn().mockResolvedValue({ id: 'pgc' }) },
    };
    return { svc: montarService(prisma, asaas), prisma, asaas };
  }

  it('404 sem consultar o Asaas nem gravar CPF no lead alheio', async () => {
    const { svc, prisma, asaas } = montar(A);
    await expect(svc.linkCustomerToLead('cus_x', 'lead-a', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(asaas.getCustomer).not.toHaveBeenCalled();
    expect(prisma.paymentGatewayCustomer.create).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('lead órfão (sem tenant) também é recusado pra quem tem clínica', async () => {
    const { svc, prisma } = montar(null);
    await expect(svc.linkCustomerToLead('cus_x', 'lead-a', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCustomer.create).not.toHaveBeenCalled();
  });

  it('na própria clínica vincula como antes', async () => {
    const { svc, prisma } = montar(A);
    await svc.linkCustomerToLead('cus_x', 'lead-a', A);
    expect(prisma.paymentGatewayCustomer.create).toHaveBeenCalledTimes(1);
  });
});

describe('unlinkCustomer (DELETE customers/:id) — vínculo de outra clínica', () => {
  function montar(tenant_id: string | null) {
    const prisma: any = {
      paymentGatewayCustomer: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pgc-a', tenant_id }),
        delete: jest.fn().mockResolvedValue({ id: 'pgc-a' }),
      },
    };
    return { svc: montarService(prisma), prisma };
  }

  it('404 e não apaga', async () => {
    const { svc, prisma } = montar(A);
    await expect(svc.unlinkCustomer('pgc-a', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCustomer.delete).not.toHaveBeenCalled();
  });

  it('vínculo sem tenant também não é apagado por quem tem clínica', async () => {
    const { svc, prisma } = montar(null);
    await expect(svc.unlinkCustomer('pgc-a', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCustomer.delete).not.toHaveBeenCalled();
  });

  it('na própria clínica apaga como antes', async () => {
    const { svc, prisma } = montar(A);
    await svc.unlinkCustomer('pgc-a', A);
    expect(prisma.paymentGatewayCustomer.delete).toHaveBeenCalledWith({ where: { id: 'pgc-a' } });
  });

  it('o controller repassa o tenant de quem chama', async () => {
    const service: any = { unlinkCustomer: jest.fn().mockResolvedValue({}) };
    const ctrl = new PaymentGatewayController(service, {} as any, {} as any, {} as any);
    await ctrl.unlinkCustomer('pgc-a', { user: { id: 'u1', tenant_id: B } });
    expect(service.unlinkCustomer).toHaveBeenCalledWith('pgc-a', B);
  });
});

describe('BoletoDeliveryService — plan_id de outra clínica (teste e "boleto do mês")', () => {
  function montar() {
    const prisma: any = {
      treatmentPlan: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === 'plan-a' && where.patient?.tenant_id === A ? { id: 'plan-a' } : null),
      },
      paymentGatewayCharge: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    };
    const whatsapp: any = { sendText: jest.fn(), sendMedia: jest.fn() };
    const svc = new BoletoDeliveryService(prisma, {} as any, whatsapp);
    return { svc, prisma, whatsapp };
  }

  it('teste com venda de outra clínica → 404, não busca boletos nem envia', async () => {
    const { svc, prisma, whatsapp } = montar();
    await expect(svc.deliverNow('plan-a', B, '82999990000')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCharge.findFirst).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('plan_id vazio → 404 (antes "plan:" casava todos os boletos da clínica)', async () => {
    const { svc, prisma } = montar();
    await expect(svc.deliverNow('', A, '82999990000')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.sendCurrentBoleto(undefined as any, A)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCharge.findFirst).not.toHaveBeenCalled();
    expect(prisma.paymentGatewayCharge.findMany).not.toHaveBeenCalled();
  });

  it('"boleto do mês" com venda de outra clínica → 404, não envia', async () => {
    const { svc, prisma, whatsapp } = montar();
    await expect(svc.sendCurrentBoleto('plan-a', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paymentGatewayCharge.findMany).not.toHaveBeenCalled();
    expect(whatsapp.sendMedia).not.toHaveBeenCalled();
  });

  it('na própria clínica segue o fluxo de antes', async () => {
    const { svc, prisma } = montar();
    const r = await svc.deliverNow('plan-a', A, '82999990000');
    expect(prisma.paymentGatewayCharge.findFirst).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false); // sem boleto em aberto no fake → a mesma resposta de antes
    const r2 = await svc.sendCurrentBoleto('plan-a', A);
    expect(r2).toEqual({ ok: false, detail: 'Esta venda não tem boleto em aberto.' });
  });
});
