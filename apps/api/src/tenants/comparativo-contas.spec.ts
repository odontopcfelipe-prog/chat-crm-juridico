/**
 * Comparativo das contas no Admin SaaS: cada número é contado só na conta dele
 * (toda consulta leva o tenant_id daquela coluna), no mês pedido (bordas de
 * Maceió), e um número que falha vira "—" sem derrubar o resto.
 */
import { Logger } from '@nestjs/common';
import { ComparativoContasService } from './comparativo-contas.service';
import { bordasDoMes, idsDoComparativo, mesDoComparativo, MAX_CONTAS_NO_COMPARATIVO } from './comparativo-contas';

beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('mês e ids', () => {
  it('mês AAAA-MM válido fica; inválido/ausente = mês de Maceió (UTC-3)', () => {
    expect(mesDoComparativo('2026-10')).toBe('2026-10');
    // 1º/nov 01:00Z ainda é 31/out em Maceió
    expect(mesDoComparativo(undefined, new Date('2026-11-01T01:00:00Z'))).toBe('2026-10');
    expect(mesDoComparativo('2026-13', new Date('2026-11-03T15:00:00Z'))).toBe('2026-11');
  });

  it('bordas: real = 03:00Z (Maceió), agenda = naive 00:00Z, fim inclusivo igual ao Financeiro', () => {
    const b = bordasDoMes('2026-12');
    expect(b.real.inicio.toISOString()).toBe('2026-12-01T03:00:00.000Z');
    expect(b.real.fim.toISOString()).toBe('2027-01-01T03:00:00.000Z');
    expect(b.fimInclusivo.toISOString()).toBe('2027-01-01T02:59:59.999Z');
    expect(b.agenda.inicio.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(b.agenda.fim.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('ids: sem vazio nem repetido, no máximo 20', () => {
    expect(idsDoComparativo(' a, b,,a ,c')).toEqual(['a', 'b', 'c']);
    expect(idsDoComparativo(undefined)).toEqual([]);
    const muitos = Array.from({ length: 30 }, (_, i) => `t${i}`).join(',');
    expect(idsDoComparativo(muitos)).toHaveLength(MAX_CONTAS_NO_COMPARATIVO);
  });
});

describe('ComparativoContasService', () => {
  function montar() {
    const consultas: any[] = [];
    const conta = (where: any) => {
      consultas.push(where);
      return where.tenant_id === 'a' ? 10 : 3;
    };
    const prisma: any = {
      tenant: {
        findMany: jest.fn(async () => [
          { id: 'a', name: 'Clínica A', status: 'ACTIVE', plan: 'PRO', business_profile: null },
          { id: 'b', name: 'Lab B', status: 'ACTIVE', plan: 'CUSTOM', business_profile: { business_type: 'LABORATORIO' } },
        ]),
      },
      user: { count: jest.fn(async ({ where }: any) => conta(where)) },
      patient: { count: jest.fn(async ({ where }: any) => conta(where)) },
      lead: { count: jest.fn(async ({ where }: any) => conta(where)) },
      calendarEvent: { count: jest.fn(async ({ where }: any) => conta(where)) },
    };
    const charges: any = {
      getDashboard: jest.fn(async ({ tenantId }: any) => {
        if (tenantId === 'b') throw new Error('sem cobranças');
        return { recebido_no_periodo: { value: 1500.5 }, a_receber_total: { value: 9000 }, atrasado: { value: 700, count: 4 } };
      }),
    };
    return { svc: new ComparativoContasService(prisma, charges), consultas, charges };
  }

  it('uma coluna por conta, na ordem pedida; id desconhecido some; cada consulta só na conta dela', async () => {
    const { svc, consultas, charges } = montar();
    const r = await svc.comparar('b,x,a', '2026-10');
    expect(r.mes).toBe('2026-10');
    expect(r.contas.map((c) => [c.id, c.nome, c.tipo])).toEqual([
      ['b', 'Lab B', 'LABORATORIO'],
      ['a', 'Clínica A', 'CLINICA'],
    ]);
    const a = r.contas[1];
    expect(a).toMatchObject({
      usuarios: 10, pacientes: 10, pacientes_novos: 10, leads_novos: 10,
      consultas: { marcadas: 10, compareceram: 10, faltaram: 10 },
      financeiro: { recebido: 1500.5, a_receber: 9000, atrasado: 700, atrasado_qtd: 4 },
    });
    // Toda contagem leva o tenant_id de UMA conta (nunca sem filtro, nunca as duas).
    expect(consultas).toHaveLength(14);
    expect(consultas.every((w) => w.tenant_id === 'a' || w.tenant_id === 'b')).toBe(true);
    expect(consultas.filter((w) => w.tenant_id === 'a')).toHaveLength(7);
    expect(charges.getDashboard).toHaveBeenCalledWith({
      tenantId: 'a', startDate: '2026-10-01T03:00:00.000Z', endDate: '2026-11-01T02:59:59.999Z',
    });
    // Agenda pelo relógio naive de Maceió, só consultas.
    expect(consultas.find((w) => w.tenant_id === 'a' && w.type)).toMatchObject({
      type: 'CONSULTA',
      start_at: { gte: new Date('2026-10-01T00:00:00Z'), lt: new Date('2026-11-01T00:00:00Z') },
    });
  });

  it('número que falha vira null só nele', async () => {
    const { svc } = montar();
    const r = await svc.comparar('b', '2026-10');
    expect(r.contas[0].financeiro).toBeNull();
    expect(r.contas[0].pacientes).toBe(3);
  });

  it('sem ids: lista vazia, sem consulta', async () => {
    const { svc, consultas } = montar();
    await expect(svc.comparar('', undefined)).resolves.toMatchObject({ contas: [] });
    expect(consultas).toEqual([]);
  });
});
