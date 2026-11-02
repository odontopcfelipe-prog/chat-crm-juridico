/**
 * F9 do laboratório — chip por função (WhatsappService.getInstanceForPurpose).
 *
 * Clínica: só o chip da função pedida; sem ele, null (a cobrança segue a volta de
 * sempre, Financeiro → Clínica, no próprio serviço que chama). Laboratório com um só
 * número (Comercial): a cobrança e os avisos saem por ele. Nunca chip de outra conta.
 *
 * Repositório público: ids fictícios.
 */
import { __limparCacheLabTenants } from '@crm/shared';
import { WhatsappService } from './whatsapp.service';
import { voltaDoChipNoLaboratorio } from './chip-do-laboratorio';

const LAB = 'lab-exemplo';
const CLINICA = 'clinica-exemplo';

type Chip = { tenant_id: string; purpose: string; name: string };

function montar(chips: Chip[], labs: string[] = [LAB]) {
  const prisma: any = {
    instance: {
      findFirst: jest.fn(async ({ where }: any) => {
        const hit = chips.find((c) => c.tenant_id === where.tenant_id && c.purpose === where.purpose && where.type === 'whatsapp');
        return hit ? { name: hit.name } : null;
      }),
    },
    tenantBusinessProfile: {
      findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))),
    },
  };
  const svc = new WhatsappService({} as any, {} as any, prisma);
  return { svc, prisma };
}

describe('chip por função — volta do laboratório', () => {
  beforeEach(() => __limparCacheLabTenants());

  it('ordem: Financeiro → Atendimento → Comercial; Atendimento → Comercial; Comercial não volta', () => {
    expect(voltaDoChipNoLaboratorio('FINANCEIRO')).toEqual(['CLINICA', 'COMERCIAL']);
    expect(voltaDoChipNoLaboratorio('CLINICA')).toEqual(['COMERCIAL']);
    expect(voltaDoChipNoLaboratorio('COMERCIAL')).toEqual([]);
  });

  it('com o chip da função: devolve ele, sem ler a lista de laboratórios', async () => {
    const m = montar([{ tenant_id: CLINICA, purpose: 'FINANCEIRO', name: 'clin-fin' }]);
    await expect(m.svc.getInstanceForPurpose(CLINICA, 'FINANCEIRO')).resolves.toBe('clin-fin');
    expect(m.prisma.instance.findFirst).toHaveBeenCalledTimes(1);
    expect(m.prisma.tenantBusinessProfile.findMany).not.toHaveBeenCalled();
  });

  it('clínica sem chip Financeiro: null, sem procurar outra função (mesmo tendo Comercial)', async () => {
    const m = montar([
      { tenant_id: CLINICA, purpose: 'COMERCIAL', name: 'clin-com' },
      { tenant_id: CLINICA, purpose: 'CLINICA', name: 'clin-cli' },
    ]);
    await expect(m.svc.getInstanceForPurpose(CLINICA, 'FINANCEIRO')).resolves.toBeNull();
    expect(m.prisma.instance.findFirst).toHaveBeenCalledTimes(1);
  });

  it('laboratório só com o Comercial: Financeiro e Atendimento saem pelo Comercial', async () => {
    const m = montar([{ tenant_id: LAB, purpose: 'COMERCIAL', name: 'lab-com' }]);
    await expect(m.svc.getInstanceForPurpose(LAB, 'FINANCEIRO')).resolves.toBe('lab-com');
    await expect(m.svc.getInstanceForPurpose(LAB, 'CLINICA')).resolves.toBe('lab-com');
    await expect(m.svc.getInstanceForPurpose(LAB, 'COMERCIAL')).resolves.toBe('lab-com');
  });

  it('laboratório com Atendimento e Comercial: a cobrança prefere o Atendimento', async () => {
    const m = montar([
      { tenant_id: LAB, purpose: 'COMERCIAL', name: 'lab-com' },
      { tenant_id: LAB, purpose: 'CLINICA', name: 'lab-cli' },
    ]);
    await expect(m.svc.getInstanceForPurpose(LAB, 'FINANCEIRO')).resolves.toBe('lab-cli');
  });

  it('laboratório com chip Financeiro: usa o Financeiro', async () => {
    const m = montar([
      { tenant_id: LAB, purpose: 'COMERCIAL', name: 'lab-com' },
      { tenant_id: LAB, purpose: 'FINANCEIRO', name: 'lab-fin' },
    ]);
    await expect(m.svc.getInstanceForPurpose(LAB, 'FINANCEIRO')).resolves.toBe('lab-fin');
  });

  it('nunca usa chip de outra conta: laboratório sem chip nenhum dá null', async () => {
    const m = montar([
      { tenant_id: CLINICA, purpose: 'COMERCIAL', name: 'clin-com' },
      { tenant_id: CLINICA, purpose: 'FINANCEIRO', name: 'clin-fin' },
    ]);
    await expect(m.svc.getInstanceForPurpose(LAB, 'FINANCEIRO')).resolves.toBeNull();
    for (const [args] of m.prisma.instance.findFirst.mock.calls) expect(args.where.tenant_id).toBe(LAB);
  });

  it('função desconhecida ou sem conta: null, sem consulta', async () => {
    const m = montar([{ tenant_id: LAB, purpose: 'COMERCIAL', name: 'lab-com' }]);
    await expect(m.svc.getInstanceForPurpose(LAB, 'OUTRA')).resolves.toBeNull();
    await expect(m.svc.getInstanceForPurpose('', 'FINANCEIRO')).resolves.toBeNull();
    expect(m.prisma.instance.findFirst).not.toHaveBeenCalled();
  });
});
