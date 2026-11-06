/**
 * Laboratório — campanha manual: o chip é sempre o da própria conta (o número único do
 * laboratório atende o setor Financeiro quando não há chip Financeiro), o filtro de
 * dentista responsável da clínica é ignorado e os textos são os do laboratório.
 * A clínica não muda: setor Financeiro sem chip Financeiro continua sem chip.
 *
 * Banco de teste: dublê em memória. Dados de exemplo (repositório público).
 */
import { __limparCacheLabTenants } from '@crm/shared';
import { CampanhasEnvioService } from './campanhas-envio.service';
import { CampanhasService } from './campanhas.service';
import { LAB_CAMPANHAS_MOTIVOS } from './lab-campanhas-textos';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';

const LAB = 'conta-lab';
const CLINICA = 'conta-clinica';

beforeEach(() => __limparCacheLabTenants());

function montar(chips: any[]) {
  const pacientesWhere: any[] = [];
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    instance: { findMany: jest.fn(async () => chips) },
    patient: {
      findMany: jest.fn(async (a: any) => {
        pacientesWhere.push(a.where);
        return [];
      }),
    },
    manualCampaign: { findFirst: jest.fn(async () => ({ id: 'C1', setor: 'FINANCEIRO', text: 'oi', status: 'RASCUNHO' })) },
    manualCampaignMedia: { findMany: jest.fn(async () => []) },
  };
  const envio = new CampanhasEnvioService(prisma, {} as any, {} as any);
  const svc = new CampanhasService(prisma, {} as any, envio);
  return { prisma, envio, svc, pacientesWhere };
}

describe('campanha com a conta de laboratório suspensa ou congelada', () => {
  // Terça, 12:00 em Maceió: dentro do horário de envio.
  const AGORA = new Date('2027-01-12T15:00:00.000Z');
  function motor(conta: { status?: string; chaves?: string[]; tenant?: string }) {
    const tenant_id = conta.tenant ?? LAB;
    const campanha: any = { id: 'C1', tenant_id, setor: 'CLINICA', text: 'Oi', name: 'Promo', status: 'ENVIANDO' };
    const prisma: any = {
      tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
      tenant: { findUnique: jest.fn(async () => ({ status: conta.status ?? 'ACTIVE', name: 'Conta' })) },
      globalSetting: {
        findMany: jest.fn(async ({ where }: any) => (conta.chaves ?? []).filter((k) => where.key.in.includes(k)).map(() => ({ value: 'true' }))),
        findUnique: jest.fn(async () => null),
      },
      manualCampaign: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.id === campanha.id && where.status === campanha.status) Object.assign(campanha, data);
          return { count: 1 };
        }),
        findMany: jest.fn(async () => (campanha.status === 'ENVIANDO' ? [campanha] : [])),
        update: jest.fn(async () => ({})),
      },
      manualCampaignItem: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 1 })),
        count: jest.fn(async () => 1),
        findFirst: jest.fn(async () => null),
      },
      manualCampaignMedia: { findMany: jest.fn(async () => []) },
      dispatchLog: { count: jest.fn(async () => 0) },
      clinicHoliday: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      holiday: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      instance: { findMany: jest.fn(async () => [{ name: 'chip-aten', purpose: 'CLINICA' }]) },
      whatsappChipPacer: { createMany: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const envio = new CampanhasEnvioService(prisma, {} as any, {} as any);
    return { prisma, envio, campanha };
  }

  it.each([
    ['SUSPENDED', { status: 'SUSPENDED' }],
    ['DELETED', { status: 'DELETED' }],
    ['LAB_FREEZE', { chaves: ['LAB_FREEZE'] }],
    ['LAB_FREEZE_<conta>', { chaves: [`LAB_FREEZE_${LAB}`] }],
  ])('%s: pausa com o motivo, sem pegar a vez do chip nem item', async (_n, conta) => {
    const { prisma, envio, campanha } = motor(conta);
    await (envio as any).processarCampanha(campanha, AGORA);
    expect(campanha).toMatchObject({ status: 'PAUSADA', pause_reason: LAB_CAMPANHAS_MOTIVOS.contaSuspensa });
    expect(prisma.whatsappChipPacer.updateMany).not.toHaveBeenCalled();
    expect(prisma.manualCampaignItem.findFirst).not.toHaveBeenCalled();
  });

  it('o texto do motivo não fala de clínica', () => {
    expect(temPalavraDeClinica(LAB_CAMPANHAS_MOTIVOS.contaSuspensa)).toBe(false);
  });

  it('conta em teste segue enviando normalmente', async () => {
    const { prisma, envio, campanha } = motor({ status: 'TRIAL' });
    await (envio as any).processarCampanha(campanha, AGORA);
    expect(campanha.status).toBe('ENVIANDO');
    expect(prisma.whatsappChipPacer.updateMany).toHaveBeenCalled();
  });

  it('a clínica não lê o status da conta nem pausa por ele', async () => {
    const { prisma, envio, campanha } = motor({ status: 'SUSPENDED', tenant: CLINICA });
    await (envio as any).processarCampanha(campanha, AGORA);
    expect(campanha.status).toBe('ENVIANDO');
    expect(prisma.globalSetting.findMany).not.toHaveBeenCalled();
  });
});

describe('chip do setor no laboratório', () => {
  it('Financeiro sem chip Financeiro usa o Atendimento e depois o Comercial da própria conta', async () => {
    const so = montar([{ name: 'com', purpose: 'COMERCIAL' }]);
    expect(await so.envio.chipDoSetor(LAB, 'FINANCEIRO')).toBe('com');
    const dois = montar([{ name: 'com', purpose: 'COMERCIAL' }, { name: 'aten', purpose: 'CLINICA' }]);
    expect(await dois.envio.chipDoSetor(LAB, 'FINANCEIRO')).toBe('aten');
    const nenhum = montar([]);
    expect(await nenhum.envio.chipDoSetor(LAB, 'FINANCEIRO')).toBeNull();
  });

  it('chip Financeiro, quando existe, continua sendo o do Financeiro', async () => {
    const { envio } = montar([{ name: 'com', purpose: 'COMERCIAL' }, { name: 'fin', purpose: 'FINANCEIRO' }]);
    expect(await envio.chipDoSetor(LAB, 'FINANCEIRO')).toBe('fin');
  });

  it('clínica: Financeiro sem chip Financeiro segue sem chip', async () => {
    const { envio } = montar([{ name: 'com', purpose: 'COMERCIAL' }, { name: 'clin', purpose: 'CLINICA' }]);
    expect(await envio.chipDoSetor(CLINICA, 'FINANCEIRO')).toBeNull();
  });
});

describe('enviar teste', () => {
  function montarTeste() {
    const m = montar([{ name: 'aten', purpose: 'CLINICA' }]);
    m.prisma.tenant = { findUnique: jest.fn(async () => ({ name: 'Conta Exemplo' })) };
    m.prisma.manualCampaign.findFirst = jest.fn(async () => ({ id: 'C1', setor: 'CLINICA', text: 'oi', status: 'RASCUNHO' }));
    const enviarPara = jest.spyOn(m.envio, 'enviarPara').mockResolvedValue({ saiu: true, erros: [] } as any);
    return { svc: m.svc, enviarPara };
  }

  it('laboratório: o nome de exemplo é neutro', async () => {
    const t = montarTeste();
    await t.svc.testar(LAB, 'C1', '82988887777');
    expect(t.enviarPara.mock.calls[0][5]).toMatchObject({ nome: 'Contato de teste', nome_completo: 'Contato de teste' });
  });

  it('clínica: o exemplo de sempre', async () => {
    const t = montarTeste();
    await t.svc.testar(CLINICA, 'C1', '82988887777');
    expect(t.enviarPara.mock.calls[0][5]).toMatchObject({ nome: 'Felipe (teste)', nome_completo: 'Felipe Passos (teste)' });
  });
});

describe('público e textos no laboratório', () => {
  it('o filtro de dentista responsável é ignorado no laboratório e mantido na clínica', async () => {
    const lab = montar([]);
    await lab.svc.publico(LAB, { dentistaId: 'd1', tagIds: ['t1'] });
    expect(JSON.stringify(lab.pacientesWhere[0])).not.toContain('primary_dentist_id');
    expect(JSON.stringify(lab.pacientesWhere[0])).toContain('t1');
    const cli = montar([]);
    await cli.svc.publico(CLINICA, { dentistaId: 'd1' });
    expect(JSON.stringify(cli.pacientesWhere[0])).toContain('primary_dentist_id');
  });

  it('sem chip, o laboratório recebe a mensagem do laboratório e a clínica a de sempre', async () => {
    const lab = montar([]);
    await expect(lab.svc.iniciar(LAB, 'C1')).rejects.toThrow('neste laboratório');
    const cli = montar([]);
    await expect(cli.svc.iniciar(CLINICA, 'C1')).rejects.toThrow('nesta clínica');
    expect(LAB_CAMPANHAS_MOTIVOS.clienteArquivado).toBe('cliente arquivado/removido');
  });
});
