/**
 * Fase 0 — aviso imediato aos ADMs (troca da conta Asaas etc.): chip FINANCEIRO
 * primeiro, para no primeiro envio REAL, chip caído (428) cai pro seguinte, o sino
 * recebe a notificação sempre e nada propaga erro.
 */
import { avisarAdmsSeguranca, avisoEntregue, DISPARO_ALERTA_SEGURANCA } from './aviso-adm-seguranca.util';

const TENANT = 't1';
const ADM_PHONE = '82996578143';
const ADM_PHONE_ENVIO = '5582996578143';

type Opts = {
  admins?: Array<{ id: string; name?: string; phone?: string | null; roles?: string[]; disparos_off?: string[]; disparos_on?: string[] }>;
  central?: string | null;
  chips?: Array<{ name: string; purpose: string | null }>;
};

function makePrisma(o: Opts = {}) {
  const admins = o.admins ?? [{ id: 'adm1', name: 'Ana', phone: ADM_PHONE, roles: ['ADMIN'], disparos_off: [], disparos_on: [] }];
  return {
    user: {
      findMany: jest.fn(async (args: any) => {
        // loadAdminAlertMembers filtra por telefone; o sino pega todo ADMIN.
        if (args?.where?.phone) return admins.filter((a) => a.phone);
        return admins.map((a) => ({ id: a.id }));
      }),
    },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.key === `VENDA_FEITA_PHONE_${TENANT}` && o.central ? { key: where.key, value: o.central } : null,
      ),
    },
    instance: {
      findMany: jest.fn(async () =>
        o.chips ?? [
          { name: 'outro', purpose: 'COMERCIAL' },
          { name: 'clinica', purpose: 'CLINICA' },
          { name: 'fin', purpose: 'FINANCEIRO' },
        ],
      ),
    },
    notification: { createMany: jest.fn(async ({ data }: any) => ({ count: data.length })) },
  };
}

const AVISO = { titulo: 'Conta Asaas alterada', texto: 'A conta mudou', data: { tipo: 'ASAAS_CONTA_ALTERADA' } };
const ok = (id = 'm1') => ({ key: { id } });

describe('avisoEntregue (mesma regra do QuotesService.wasSent)', () => {
  it('só é entregue com id de mensagem e sem statusCode de erro', () => {
    expect(avisoEntregue({ key: { id: 'x' } })).toBe(true);
    expect(avisoEntregue({ statusCode: 428, error: 'Connection Closed' })).toBe(false);
    expect(avisoEntregue({ exists: false })).toBe(false);
    expect(avisoEntregue(null)).toBe(false);
  });
});

describe('avisarAdmsSeguranca', () => {
  it('o id do aviso fica fora do catálogo (ninguém desliga)', () => {
    expect(DISPARO_ALERTA_SEGURANCA).toBe('alerta_seguranca');
  });

  it('tenta o chip FINANCEIRO primeiro e para no primeiro envio com key.id', async () => {
    const prisma = makePrisma();
    const sendText = jest.fn().mockResolvedValue(ok());
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText } }, TENANT, AVISO);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(ADM_PHONE_ENVIO, AVISO.texto, 'fin', undefined, TENANT);
    expect(r.whatsapp).toBe(1);
  });

  it('{statusCode:428} cai pro chip seguinte (CLINICA) e para nele', async () => {
    const prisma = makePrisma();
    const sendText = jest.fn()
      .mockResolvedValueOnce({ statusCode: 428, error: 'Connection Closed' })
      .mockResolvedValueOnce(ok());
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText } }, TENANT, AVISO);
    expect(sendText.mock.calls.map((c) => c[2])).toEqual(['fin', 'clinica']);
    expect(r.whatsapp).toBe(1);
  });

  it('chip que LANÇA também cai pro seguinte', async () => {
    const prisma = makePrisma();
    const sendText = jest.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(ok());
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText } }, TENANT, AVISO);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(r.whatsapp).toBe(1);
  });

  it('manda pra Central e pros ADMs (sem repetir o mesmo número)', async () => {
    const prisma = makePrisma({ central: `82988887777, ${ADM_PHONE}` });
    const sendText = jest.fn().mockResolvedValue(ok());
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText } }, TENANT, AVISO);
    expect(sendText.mock.calls.map((c) => c[0]).sort()).toEqual(['5582988887777', ADM_PHONE_ENVIO].sort());
    expect(r.whatsapp).toBe(2);
  });

  it('ADM que desligou outros avisos no cadastro continua recebendo este', async () => {
    const prisma = makePrisma({
      admins: [{ id: 'adm1', phone: ADM_PHONE, roles: ['ADMIN'], disparos_off: ['venda_feita'], disparos_on: [] }],
    });
    const sendText = jest.fn().mockResolvedValue(ok());
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText } }, TENANT, AVISO);
    expect(r.whatsapp).toBe(1);
  });

  it('cria a notificação de cada ADMIN mesmo com zero telefones', async () => {
    const prisma = makePrisma({
      admins: [
        { id: 'adm1', phone: null, roles: ['ADMIN'] },
        { id: 'adm2', phone: null, roles: ['ADMIN'] },
      ],
    });
    const sendText = jest.fn();
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText } }, TENANT, AVISO);
    expect(sendText).not.toHaveBeenCalled();
    expect(r).toEqual({ whatsapp: 0, notificacoes: 2 });
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        { user_id: 'adm1', tenant_id: TENANT, notification_type: 'security_alert', title: AVISO.titulo, body: AVISO.texto, data: AVISO.data },
        { user_id: 'adm2', tenant_id: TENANT, notification_type: 'security_alert', title: AVISO.titulo, body: AVISO.texto, data: AVISO.data },
      ],
    });
  });

  it('sem whatsapp ainda cria a notificação', async () => {
    const prisma = makePrisma();
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: null }, TENANT, AVISO);
    expect(r).toEqual({ whatsapp: 0, notificacoes: 1 });
  });

  it('nenhum chip entregou: conta zero e avisa no logger', async () => {
    const prisma = makePrisma();
    const sendText = jest.fn().mockResolvedValue({ statusCode: 428 });
    const warn = jest.fn();
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText }, logger: { warn } }, TENANT, AVISO);
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(r.whatsapp).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('erro do prisma não propaga (e um canal falhar não derruba o outro)', async () => {
    const prisma = makePrisma();
    prisma.notification.createMany.mockRejectedValue(new Error('db fora'));
    const sendText = jest.fn().mockResolvedValue(ok());
    const warn = jest.fn();
    const r = await avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText }, logger: { warn } }, TENANT, AVISO);
    expect(r).toEqual({ whatsapp: 1, notificacoes: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db fora'));

    const quebrado = makePrisma();
    quebrado.user.findMany.mockRejectedValue(new Error('pool esgotado'));
    quebrado.instance.findMany.mockRejectedValue(new Error('pool esgotado'));
    await expect(
      avisarAdmsSeguranca({ prisma: quebrado as any, whatsapp: { sendText: jest.fn() } }, TENANT, AVISO),
    ).resolves.toEqual({ whatsapp: 0, notificacoes: 0 });
  });

  it('sem tenant não faz nada', async () => {
    const prisma = makePrisma();
    const sendText = jest.fn();
    await expect(avisarAdmsSeguranca({ prisma: prisma as any, whatsapp: { sendText } }, '', AVISO)).resolves.toEqual({
      whatsapp: 0,
      notificacoes: 0,
    });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});
