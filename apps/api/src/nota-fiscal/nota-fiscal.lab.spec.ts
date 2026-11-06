/**
 * Nota fiscal (NFS-e) no laboratório: configuração e emissão só da PRÓPRIA conta,
 * sem os valores de reserva da clínica (CNAE, alíquota e descrição), descrição padrão
 * "Serviços de prótese dentária" e emissão automática desligada até a conta ligar.
 * A clínica continua com as respostas e as chamadas de sempre.
 *
 * Sem banco: o Prisma e as configurações são dublês com dados de exemplo.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { NotaFiscalService } from './nota-fiscal.service';
import { LAB_NFSE } from './lab-nota-fiscal-textos';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';

const LAB = 'conta-lab-exemplo';
const CLINICA = 'conta-clinica-exemplo';

function montar(config: Record<string, string>, transacoes: Record<string, any> = {}) {
  __limparCacheLabTenants();
  const gravados: Array<[string, string]> = [];
  const criadas: any[] = [];
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    financialTransaction: { findUnique: jest.fn(async ({ where }: any) => transacoes[where.id] ?? null) },
    notaFiscal: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => (criadas.push(data), { id: 'nf-1', ...data })),
    },
  };
  const settings: any = {
    get: jest.fn(async (k: string) => config[k] ?? null),
    upsert: jest.fn(async (k: string, v: string) => (gravados.push([k, v]), { key: k, value: v })),
  };
  return { svc: new NotaFiscalService(prisma, settings), prisma, settings, gravados, criadas };
}

const CONFIG_LAB_COMPLETA = {
  [`nfse_provider_${LAB}`]: 'enotas',
  [`nfse_api_key_${LAB}`]: 'chave-exemplo',
  [`nfse_cnpj_${LAB}`]: '11222333000181',
  [`nfse_cnae_code_${LAB}`]: '3250-7/06',
  [`nfse_default_iss_rate_${LAB}`]: '2.00',
};
const TRANSACAO_LAB = { id: 'tx-lab', tenant_id: LAB, amount: 500, lead_id: null, lead: { id: 'l-1', name: 'Dr. Cliente Exemplo', email: null } };

describe('NFS-e do laboratório — configuração', () => {
  it('sem nada preenchido: CNAE e alíquota voltam vazios, descrição padrão do laboratório, emissão automática desligada', async () => {
    const m = montar({});
    const r = await m.svc.getConfig(LAB);
    expect(r).toMatchObject({
      configured: false, cnae_code: null, default_iss_rate: null, auto_emit: false,
      servico_descricao: 'Serviços de prótese dentária',
    });
  });

  it('com o que o laboratório preencheu: devolve o dele', async () => {
    const m = montar({ ...CONFIG_LAB_COMPLETA, [`nfse_servico_descricao_${LAB}`]: 'Prótese sobre implante' });
    const r = await m.svc.getConfig(LAB);
    expect(r).toMatchObject({ configured: true, cnae_code: '3250-7/06', default_iss_rate: '2.00', servico_descricao: 'Prótese sobre implante' });
  });

  it('clínica: as respostas de sempre, com os valores de reserva dela', async () => {
    const m = montar({});
    expect(await m.svc.getConfig(CLINICA)).toEqual({
      configured: false, provider: null, has_api_key: false, cnpj: null, inscricao_municipal: null,
      cnae_code: '6911-7/01', default_iss_rate: '5.00', auto_emit: false, servico_descricao: 'Servicos advocaticios',
    });
  });

  it('a leitura usa só as chaves da própria conta', async () => {
    const m = montar({});
    await m.svc.getConfig(LAB);
    const lidas = m.settings.get.mock.calls.map((c: any[]) => c[0] as string);
    expect(lidas.length).toBeGreaterThan(0);
    for (const k of lidas) expect(k.endsWith(`_${LAB}`)).toBe(true);
  });
});

describe('NFS-e do laboratório — salvar a configuração', () => {
  it('grava nas chaves da própria conta, normaliza o CNPJ e a alíquota e deixa a emissão automática desligada', async () => {
    const m = montar({});
    await m.svc.saveConfigLab(LAB, {
      provider: 'EnOtas', api_key: 'chave-exemplo', cnpj: '11.222.333/0001-81', inscricao_municipal: '123',
      cnae_code: '3250-7/06', default_iss_rate: '2,5', servico_descricao: '',
    });
    expect(Object.fromEntries(m.gravados)).toEqual({
      [`nfse_provider_${LAB}`]: 'enotas',
      [`nfse_cnpj_${LAB}`]: '11222333000181',
      [`nfse_inscricao_municipal_${LAB}`]: '123',
      [`nfse_cnae_code_${LAB}`]: '3250-7/06',
      [`nfse_default_iss_rate_${LAB}`]: '2.5',
      [`nfse_auto_emit_${LAB}`]: 'false',
      [`nfse_servico_descricao_${LAB}`]: '',
      [`nfse_api_key_${LAB}`]: 'chave-exemplo',
    });
  });

  it('chave da API em branco: mantém a atual (não grava)', async () => {
    const m = montar({});
    await m.svc.saveConfigLab(LAB, { provider: 'enotas', api_key: '   ' });
    expect(m.gravados.map(([k]) => k)).not.toContain(`nfse_api_key_${LAB}`);
  });

  it('emissão automática só liga quando a conta manda true', async () => {
    const m = montar({});
    await m.svc.saveConfigLab(LAB, { auto_emit: true });
    expect(Object.fromEntries(m.gravados)[`nfse_auto_emit_${LAB}`]).toBe('true');
  });

  it.each([
    ['provedor', { provider: 'outro' }, LAB_NFSE.provedorInvalido],
    ['CNPJ', { cnpj: '123' }, LAB_NFSE.cnpjInvalido],
    ['alíquota', { default_iss_rate: '150' }, LAB_NFSE.aliquotaInvalida],
  ])('%s inválido: 400 e nada gravado', async (_n, corpo, msg) => {
    const m = montar({});
    const e = await m.svc.saveConfigLab(LAB, corpo).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(msg);
    expect(m.gravados).toEqual([]);
  });

  it('clínica (e quem não tem conta): recusa VERTICAL_DENIED, nada gravado — a clínica grava pela tela de sempre', async () => {
    for (const conta of [CLINICA, '']) {
      const m = montar({});
      const e = await m.svc.saveConfigLab(conta, { provider: 'enotas' }).catch((x) => x);
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.getResponse().code).toBe(CODIGO_VERTICAL_NEGADA);
      expect(m.gravados).toEqual([]);
    }
  });
});

describe('NFS-e do laboratório — emissão', () => {
  it('sem CNAE, alíquota ou CNPJ: não emite com o valor de reserva da clínica', async () => {
    const m = montar({ [`nfse_provider_${LAB}`]: 'enotas', [`nfse_api_key_${LAB}`]: 'chave-exemplo' }, { 'tx-lab': TRANSACAO_LAB });
    const e = await m.svc.emit('tx-lab', LAB).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(LAB_NFSE.faltaDados);
    expect(m.criadas).toEqual([]);
  });

  it('com tudo preenchido: usa o CNAE e a alíquota da conta e a descrição padrão do laboratório', async () => {
    const m = montar(CONFIG_LAB_COMPLETA, { 'tx-lab': TRANSACAO_LAB });
    await m.svc.emit('tx-lab', LAB);
    expect(m.criadas).toHaveLength(1);
    expect(m.criadas[0]).toMatchObject({
      tenant_id: LAB, servico_codigo: '3250-7/06', servico_descricao: 'Serviços de prótese dentária',
      aliquota_iss: 2, valor_iss: 10, valor: 500,
    });
  });

  it('transação de outra conta: 403, nada lido da configuração nem gravado', async () => {
    const m = montar(CONFIG_LAB_COMPLETA, { 'tx-b': { id: 'tx-b', tenant_id: 'outra-conta', amount: 10, lead: null } });
    await expect(m.svc.emit('tx-b', LAB)).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.settings.get).not.toHaveBeenCalled();
    expect(m.criadas).toEqual([]);
  });

  it('clínica: continua com os valores de reserva de sempre', async () => {
    const m = montar(
      { [`nfse_provider_${CLINICA}`]: 'enotas', [`nfse_api_key_${CLINICA}`]: 'chave-exemplo' },
      { 'tx-c': { id: 'tx-c', tenant_id: CLINICA, amount: 100, lead: null } },
    );
    await m.svc.emit('tx-c', CLINICA);
    expect(m.criadas[0]).toMatchObject({ servico_codigo: '6911-7/01', servico_descricao: 'Servicos advocaticios', aliquota_iss: 5 });
  });

  it('emissão automática: sem a chave ligada na conta, não emite', async () => {
    const m = montar(CONFIG_LAB_COMPLETA, { 'tx-lab': TRANSACAO_LAB });
    expect(await m.svc.autoEmitIfEnabled('tx-lab', LAB)).toBeNull();
    expect(m.criadas).toEqual([]);
  });
});
