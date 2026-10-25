/**
 * F0b — alerta interno pelo chip padrão do servidor só para a clínica DONA dele.
 *
 * Antes, tarefa vencida, notificação por WhatsApp e follow-up legado sem chip na
 * conversa saíam pelo número de uma clínica para a equipe/leads de todas.
 */
import axios from 'axios';
import { resolveOwnedEnvChip, __limparCacheEnvChip } from './env-chip';
import { TaskAlertsCronService } from '../task/task-alerts-cron.service';
import { NotificationWhatsappProcessor } from '../notification-whatsapp/notification-whatsapp.processor';

jest.mock('axios');
const post = axios.post as jest.Mock;

function prismaCom(inst: { tenant_id: string | null; inbox?: { tenant_id: string | null } | null } | null) {
  return {
    instance: { findUnique: jest.fn(async () => inst) },
    tenant: { findFirst: jest.fn(async () => ({ id: 'instituto' })) },
  } as any;
}

const ENV = process.env.EVOLUTION_INSTANCE_NAME;
beforeEach(() => {
  process.env.EVOLUTION_INSTANCE_NAME = 'chip-padrao';
  __limparCacheEnvChip();
  post.mockReset();
  post.mockResolvedValue({ data: { key: { id: 'm1' } } });
});
afterAll(() => {
  process.env.EVOLUTION_INSTANCE_NAME = ENV;
});

describe('resolveOwnedEnvChip', () => {
  it('clínica dona do chip (Instance.tenant_id) → o chip, como antes', async () => {
    await expect(resolveOwnedEnvChip(prismaCom({ tenant_id: 'instituto' }), 'instituto', 't')).resolves.toBe('chip-padrao');
  });

  it('outra clínica → null (não envia), nunca outro chip', async () => {
    await expect(resolveOwnedEnvChip(prismaCom({ tenant_id: 'instituto' }), 'pra-sorrir', 't')).resolves.toBeNull();
  });

  it('dono pelo setor quando a Instance não tem clínica', async () => {
    const p = prismaCom({ tenant_id: null, inbox: { tenant_id: 'instituto' } });
    await expect(resolveOwnedEnvChip(p, 'instituto', 't')).resolves.toBe('chip-padrao');
    __limparCacheEnvChip();
    await expect(resolveOwnedEnvChip(p, 'pra-sorrir', 't')).resolves.toBeNull();
  });

  it('chip sem registro → a clínica mais antiga (quem sempre usou) continua recebendo', async () => {
    const p = prismaCom(null);
    await expect(resolveOwnedEnvChip(p, 'instituto', 't')).resolves.toBe('chip-padrao');
    expect(p.tenant.findFirst).toHaveBeenCalledWith({ orderBy: { created_at: 'asc' }, select: { id: true } });
    await expect(resolveOwnedEnvChip(p, 'pra-sorrir', 't')).resolves.toBeNull();
  });

  it('envio sem clínica (legado) → o chip, como antes; env vazia usa o padrão do chamador', async () => {
    await expect(resolveOwnedEnvChip(prismaCom(null), null, 't')).resolves.toBe('chip-padrao');
    delete process.env.EVOLUTION_INSTANCE_NAME;
    await expect(resolveOwnedEnvChip(prismaCom(null), null, 't', 'whatsapp')).resolves.toBe('whatsapp');
    await expect(resolveOwnedEnvChip(prismaCom(null), null, 't')).resolves.toBeNull();
  });

  it('falha ao conferir o dono → não envia (fail-closed)', async () => {
    const p = { instance: { findUnique: jest.fn(async () => { throw new Error('db fora'); }) }, tenant: {} } as any;
    await expect(resolveOwnedEnvChip(p, 'instituto', 't')).resolves.toBeNull();
  });
});

describe('quem usa', () => {
  const settings = { getEvolutionConfig: jest.fn(async () => ({ apiUrl: 'http://evo', apiKey: 'k' })) } as any;

  it('alerta de tarefa: dono → sai pelo chip; outra clínica → zero envio', async () => {
    const svc = new TaskAlertsCronService(prismaCom({ tenant_id: 'instituto' }), settings);
    await expect((svc as any).sendWhatsApp('5582999990000', 'oi', 'instituto')).resolves.toBe(true);
    await expect((svc as any).sendWhatsApp('5582999990000', 'oi', 'pra-sorrir')).resolves.toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/chip-padrao');
  });

  it.each([
    ['da clínica dona → sai pelo chip', 'instituto', 1],
    ['de outra clínica → zero envio', 'pra-sorrir', 0],
  ])('notificação por WhatsApp %s', async (_n, tenant, envios) => {
    const prisma = prismaCom({ tenant_id: 'instituto' });
    prisma.notification = {
      findUnique: jest.fn(async () => ({ id: 'n1', read_at: null, tenant_id: tenant, notification_type: 'x', data: {}, title: 'T', created_at: new Date() })),
      findFirst: jest.fn(async () => null),
    };
    prisma.user = { findUnique: jest.fn(async () => ({ phone: '5582999990000', name: 'Ana', tenant_id: tenant })) };
    prisma.notificationSetting = { findUnique: jest.fn(async () => null) };
    const proc = new NotificationWhatsappProcessor(prisma, settings);
    await proc.process({ data: { notificationId: 'n1', userId: 'u1' } } as any);
    expect(post).toHaveBeenCalledTimes(envios);
  });
});
