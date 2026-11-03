/**
 * ORIGEM das entradas (filtro Vendas rápidas / Boletos / Outras da aba Entradas):
 * findAllTransactions marca cada RECEITA pela cobrança vinculada.
 *
 *  - orçamento de balcão ("Venda rapida ...") → VENDA_RAPIDA, mesmo no PIX/cartão;
 *  - parcela do carnê (boleto), paga no banco OU na clínica → BOLETO;
 *  - entrada/sinal que nasceram boleto mas foram pagos no balcão → OUTRA;
 *  - proposta à vista, receita sem cobrança → OUTRA;
 *  - cobrança de OUTRA conta com o mesmo vínculo não vale (fica OUTRA);
 *  - elo pelo charge.transaction_id quando o reference_id não casa.
 */
import { FinanceiroService } from './financeiro.service';

const A = 'tenant-a';
const B = 'tenant-b';

const plano = (title: string, notes = '') => ({ quote: { title, notes } });

const CHARGES = [
  { external_id: 'cash-vr', transaction_id: null, tenant_id: A, billing_type: 'CASH', kind: null, received_in_cash: true, treatment_plan: plano('Venda rapida — Limpeza', 'Venda rapida — recebido na clinica: Espécie') },
  { external_id: 'pay_vr_pix', transaction_id: null, tenant_id: A, billing_type: 'PIX', kind: null, received_in_cash: false, treatment_plan: plano('Venda rápida') },
  { external_id: 'pay_parcela', transaction_id: null, tenant_id: A, billing_type: 'BOLETO', kind: null, received_in_cash: false, treatment_plan: null },
  { external_id: 'pay_parcela_balcao', transaction_id: null, tenant_id: A, billing_type: 'BOLETO', kind: 'INSTALLMENT', received_in_cash: true, treatment_plan: plano('Implante') },
  { external_id: 'pay_entrada_banco', transaction_id: null, tenant_id: A, billing_type: 'BOLETO', kind: 'ENTRADA', received_in_cash: false, treatment_plan: plano('Facetas') },
  { external_id: 'pay_entrada_balcao', transaction_id: null, tenant_id: A, billing_type: 'BOLETO', kind: 'ENTRADA', received_in_cash: true, treatment_plan: plano('Facetas') },
  { external_id: 'pay_sinal_balcao', transaction_id: null, tenant_id: A, billing_type: 'BOLETO', kind: 'SINAL', received_in_cash: true, treatment_plan: plano('Facetas') },
  { external_id: 'pay_avista_prop', transaction_id: null, tenant_id: A, billing_type: 'PIX', kind: null, received_in_cash: true, treatment_plan: plano('Coroa') },
  { external_id: 'pay_da_b', transaction_id: null, tenant_id: B, billing_type: 'BOLETO', kind: null, received_in_cash: false, treatment_plan: null },
  { external_id: 'split-x', transaction_id: 'rx-elo', tenant_id: A, billing_type: 'BOLETO', kind: 'INSTALLMENT', received_in_cash: false, treatment_plan: plano('Ortodontia') },
];

const receita = (id: string, reference_id: string | null, tenant_id = A) => ({
  id, type: 'RECEITA', category: 'PROCEDIMENTO', status: 'PAGO', amount: 100, reference_id, tenant_id, lead: { name: 'X' },
});

const ROWS = [
  receita('r-vr', 'cash-vr'),
  receita('r-vr-pix', 'pay_vr_pix'),
  receita('r-parcela', 'pay_parcela'),
  receita('r-parcela-balcao', 'pay_parcela_balcao'),
  receita('r-entrada-banco', 'pay_entrada_banco'),
  receita('r-entrada-balcao', 'pay_entrada_balcao'),
  receita('r-sinal-balcao', 'pay_sinal_balcao'),
  receita('r-avista-prop', 'pay_avista_prop'),
  receita('r-manual', null),
  receita('r-outra-conta', 'pay_da_b'), // mesmo external_id, mas a cobrança é da conta B
  receita('rx-elo', 'ref-que-nao-casa'),
];

function svcCom(rows: any[]) {
  const chargeFind = jest.fn(async ({ where }: any) => {
    const refs: string[] = where.OR.find((o: any) => o.external_id)?.external_id.in ?? [];
    const txs: string[] = where.OR.find((o: any) => o.transaction_id)?.transaction_id.in ?? [];
    return CHARGES.filter((c) => refs.includes(c.external_id) || (c.transaction_id && txs.includes(c.transaction_id)));
  });
  const prisma: any = {
    financialTransaction: {
      findMany: jest.fn(async () => rows.map((r) => ({ ...r }))),
      count: jest.fn(async () => rows.length),
    },
    paymentGatewayCharge: { findMany: chargeFind },
  };
  return { svc: new FinanceiroService(prisma, {} as any), chargeFind };
}

describe('findAllTransactions — origem das entradas', () => {
  it('marca cada receita pela cobrança vinculada', async () => {
    const { svc } = svcCom(ROWS);
    const { data } = await svc.findAllTransactions({ tenantId: A, type: 'RECEITA', status: 'PAGO' });
    const origem = Object.fromEntries((data as any[]).map((r) => [r.id, r.origem]));
    expect(origem).toEqual({
      'r-vr': 'VENDA_RAPIDA',
      'r-vr-pix': 'VENDA_RAPIDA',
      'r-parcela': 'BOLETO',
      'r-parcela-balcao': 'BOLETO',
      'r-entrada-banco': 'BOLETO',
      'r-entrada-balcao': 'OUTRA',
      'r-sinal-balcao': 'OUTRA',
      'r-avista-prop': 'OUTRA',
      'r-manual': 'OUTRA',
      'r-outra-conta': 'OUTRA',
      'rx-elo': 'BOLETO',
    });
  });

  it('despesas não ganham origem nem consultam cobranças', async () => {
    const { svc, chargeFind } = svcCom([{ ...receita('d-1', 'pay_parcela'), type: 'DESPESA' }]);
    const { data } = await svc.findAllTransactions({ tenantId: A, type: 'DESPESA' });
    expect((data as any[])[0].origem).toBeUndefined();
    expect(chargeFind).not.toHaveBeenCalled();
  });
});
