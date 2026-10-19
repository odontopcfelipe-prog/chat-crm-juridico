/**
 * Fase 0 — A2: trocar a conta Asaas da clínica desvia os próximos PIX/boletos.
 * A troca vai pro Log do Financeiro (com tenant_id na coluna e SEM a chave — só a
 * impressão digital) e os ADMs são avisados na hora. O aviso nunca derruba o setup.
 */
jest.mock('axios');
jest.mock('../common/utils/aviso-adm-seguranca.util', () => ({
  avisarAdmsSeguranca: jest.fn(),
}));

import axios from 'axios';
import { PaymentGatewayService } from './payment-gateway.service';
import { avisarAdmsSeguranca } from '../common/utils/aviso-adm-seguranca.util';

const TENANT = 't1';
const CHAVE_ANTIGA = '$aact_prod_ANTIGA_000000000000000000000000';
const CHAVE_NOVA = '$aact_prod_NOVA_1111111111111111111111111111';

function montar(o: { antes?: Record<string, string>; auditFalha?: boolean } = {}) {
  const antes = o.antes ?? { ASAAS_API_KEY: CHAVE_ANTIGA, ASAAS_BASE_URL: 'https://api.asaas.com/v3' };
  const auditCreate = o.auditFalha
    ? jest.fn().mockRejectedValue(new Error('db fora'))
    : jest.fn().mockResolvedValue({});
  const prisma: any = {
    tenantSetting: {
      findUnique: jest.fn(async ({ where }: any) => {
        const key = where.tenant_id_key.key;
        return antes[key] ? { tenant_id: TENANT, key, value: antes[key] } : null;
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Felipe' }) },
    auditLog: { create: auditCreate },
  };
  const whatsapp: any = { sendText: jest.fn() };
  const svc = new PaymentGatewayService(prisma, {} as any, whatsapp, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, auditCreate, whatsapp };
}

describe('PaymentGatewayService.setupAsaas — Fase 0 (A2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axios.get as jest.Mock).mockResolvedValue({ data: { balance: 10 } });
    (avisarAdmsSeguranca as jest.Mock).mockResolvedValue({ whatsapp: 1, notificacoes: 1 });
  });

  it('grava a auditoria com tenant_id na coluna e sem a chave no meta', async () => {
    const { svc, auditCreate } = montar();
    await expect(svc.setupAsaas(TENANT, CHAVE_NOVA, false, { userId: 'u1' })).resolves.toEqual({ ok: true, sandbox: false });

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const data = auditCreate.mock.calls[0][0].data;
    expect(data.tenant_id).toBe(TENANT);
    expect(data.actor_user_id).toBe('u1');
    expect(data.entity).toBe('FINANCEIRO');
    expect(data.action).toBe('ASAAS_CONTA_ALTERADA');
    expect(data.meta_json.descricao).toBe('Conta Asaas da clínica alterada');
    expect(data.meta_json.valor).toBe(0);
    expect(data.meta_json.before).toEqual(
      expect.objectContaining({ configurada: true, ambiente: 'producao', chave_fp: expect.stringMatching(/^[0-9a-f]{8}$/) }),
    );
    expect(data.meta_json.after).toEqual({ ambiente: 'producao', chave_fp: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(data.meta_json.before.chave_fp).not.toBe(data.meta_json.after.chave_fp);
    // NUNCA a chave (nem pedaço reconhecível dela) no rastro.
    const json = JSON.stringify(data);
    expect(json).not.toContain(CHAVE_NOVA);
    expect(json).not.toContain(CHAVE_ANTIGA);
    expect(json).not.toContain('NOVA_1111');
  });

  it('lê a conta anterior do PRÓPRIO tenant (sem conta = "não configurada")', async () => {
    const { svc, auditCreate, prisma } = montar({ antes: {} });
    await svc.setupAsaas(TENANT, CHAVE_NOVA, true, { userId: 'u1' });
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenant_id_key: { tenant_id: TENANT, key: 'ASAAS_API_KEY' } },
    });
    const meta = auditCreate.mock.calls[0][0].data.meta_json;
    expect(meta.before).toEqual({ configurada: false, ambiente: null, chave_fp: null });
    expect(meta.after.ambiente).toBe('sandbox');
  });

  it('chama o aviso aos ADMs com quem trocou e as impressões digitais', async () => {
    const { svc, prisma, whatsapp } = montar();
    await svc.setupAsaas(TENANT, CHAVE_NOVA, false, { userId: 'u1' });
    expect(avisarAdmsSeguranca).toHaveBeenCalledTimes(1);
    const [deps, tenant, aviso] = (avisarAdmsSeguranca as jest.Mock).mock.calls[0];
    expect(deps.prisma).toBe(prisma);
    expect(deps.whatsapp).toBe(whatsapp);
    expect(tenant).toBe(TENANT);
    expect(aviso.titulo).toBe('Conta Asaas alterada');
    expect(aviso.texto).toContain('Felipe');
    expect(aviso.texto).toContain('Produção');
    expect(aviso.texto).not.toContain(CHAVE_NOVA);
    expect(aviso.data).toEqual({ tipo: 'ASAAS_CONTA_ALTERADA' });
  });

  it('aviso que lança (síncrono ou rejeitado) não derruba o setup', async () => {
    (avisarAdmsSeguranca as jest.Mock).mockImplementation(() => {
      throw new Error('whatsapp caiu');
    });
    const a = montar();
    await expect(a.svc.setupAsaas(TENANT, CHAVE_NOVA, false, { userId: 'u1' })).resolves.toEqual({ ok: true, sandbox: false });
    expect(a.prisma.tenantSetting.upsert).toHaveBeenCalledTimes(2);

    (avisarAdmsSeguranca as jest.Mock).mockRejectedValue(new Error('whatsapp caiu'));
    const b = montar();
    await expect(b.svc.setupAsaas(TENANT, CHAVE_NOVA, false, { userId: 'u1' })).resolves.toEqual({ ok: true, sandbox: false });
  });

  it('falha ao gravar a auditoria não derruba o setup', async () => {
    const { svc } = montar({ auditFalha: true });
    await expect(svc.setupAsaas(TENANT, CHAVE_NOVA, false, { userId: 'u1' })).resolves.toEqual({ ok: true, sandbox: false });
  });

  it('sem usuário: rastro com ator null e aviso com "usuário desconhecido"', async () => {
    const { svc, auditCreate } = montar();
    await svc.setupAsaas(TENANT, CHAVE_NOVA, false);
    expect(auditCreate.mock.calls[0][0].data.actor_user_id).toBeNull();
    expect((avisarAdmsSeguranca as jest.Mock).mock.calls[0][2].texto).toContain('usuário desconhecido');
  });
});
