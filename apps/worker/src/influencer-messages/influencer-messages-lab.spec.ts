/**
 * Paridade do laboratório — mensagem automática para influenciadores: o laboratório
 * envia pelo WhatsApp da própria conta (Comercial, senão Atendimento; nunca o
 * Financeiro nem o chip padrão do servidor). Sem chip próprio, registra a falha.
 * A clínica segue pelo caminho de sempre. Prisma mockado, dados de exemplo.
 */
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { __limparCacheEnvChip } from '../admin-alerts/env-chip';
import { InfluencerMessagesCronService } from './influencer-messages-cron.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const LAB = 'conta-lab-1';
const settings = { getEvolutionConfig: jest.fn(async () => ({ apiUrl: 'http://evo', apiKey: 'k' })) } as any;

function prismaCom(chips: Array<{ name: string; purpose: string }>) {
  return {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    instance: {
      findMany: jest.fn(async () => chips),
      findUnique: jest.fn(async () => null),
    },
    tenant: { findFirst: jest.fn(async () => ({ id: 'outra-conta' })) },
    influencerMessageLog: { upsert: jest.fn(async () => ({})) },
  } as any;
}

const sch = { id: 's1', tenant_id: LAB, template: { body: 'Oi {{nome}}' } };
const inf = { id: 'i1', name: 'Ana', phone: '(82) 90000-0001' };
const quando = new Date('2031-01-01T15:00:00.000Z');

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
beforeEach(() => {
  __limparCacheLabTenants();
  __limparCacheEnvChip();
  post.mockReset();
  post.mockResolvedValue({ data: { key: { id: 'm1' } } });
});

describe('influenciadores com a conta de laboratório suspensa ou congelada', () => {
  function montar(conta: { status?: string; chaves?: string[] }, agendamento: any = {}) {
    const prisma: any = {
      ...prismaCom([{ name: 'com', purpose: 'COMERCIAL' }]),
      influencer: { findMany: jest.fn(async () => [inf]) },
      influencerSchedule: {
        findMany: jest.fn(async () => [{
          ...sch, schedule_type: 'RECURRING', recurrence: 'DAILY', hour: 9, minute: 0, weekdays: [], next_run_at: quando, manual_recipient_ids: ['i1'], active: true, ...agendamento,
        }]),
        update: jest.fn(async () => ({})),
      },
      globalSetting: { findMany: jest.fn(async () => (conta.chaves ?? []).map(() => ({ value: 'true' }))) },
    };
    prisma.tenant.findUnique = jest.fn(async () => ({ status: conta.status ?? 'ACTIVE' }));
    return { prisma, svc: new InfluencerMessagesCronService(prisma, settings) };
  }

  it.each([
    ['SUSPENDED', { status: 'SUSPENDED' }],
    ['DELETED', { status: 'DELETED' }],
    ['LAB_FREEZE', { chaves: ['LAB_FREEZE'] }],
  ])('%s: não envia, não lista destinatário e o recorrente anda para a próxima ocorrência', async (_n, conta) => {
    const { prisma, svc } = montar(conta);
    await svc.tick();
    expect(post).not.toHaveBeenCalled();
    expect(prisma.influencer.findMany).not.toHaveBeenCalled();
    const { data } = prisma.influencerSchedule.update.mock.calls[0][0];
    expect(data.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(data.last_run_at).toBeUndefined();
    expect(data.active).toBeUndefined();
  });

  it('o de uma vez só não se perde: olha de novo em 1 h e continua ativo', async () => {
    const { prisma, svc } = montar({ status: 'SUSPENDED' }, { schedule_type: 'ONCE', run_at: quando });
    const antes = Date.now();
    await svc.tick();
    const { data } = prisma.influencerSchedule.update.mock.calls[0][0];
    expect(data.next_run_at.getTime()).toBeGreaterThanOrEqual(antes + 59 * 60_000);
    expect(data.active).toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });

  it('conta ativa ou em teste envia; a que volta a ficar ativa volta a enviar', async () => {
    const trial = montar({ status: 'TRIAL' });
    await trial.svc.tick();
    expect(post).toHaveBeenCalledTimes(1);

    post.mockClear();
    const m = montar({ status: 'SUSPENDED' });
    await m.svc.tick();
    expect(post).not.toHaveBeenCalled();
    m.prisma.tenant.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    await m.svc.tick();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a clínica não lê o status da conta', async () => {
    const { prisma, svc } = montar({ status: 'SUSPENDED' }, { tenant_id: 'conta-clinica-1' });
    await svc.tick();
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});

describe('influenciadores no laboratório: chip da própria conta', () => {
  it('escolhe o Comercial, senão o Atendimento, e nunca o Financeiro', async () => {
    const a: any = new InfluencerMessagesCronService(prismaCom([{ name: 'fin', purpose: 'FINANCEIRO' }, { name: 'com', purpose: 'COMERCIAL' }]), settings);
    await expect(a.chipDoLaboratorio(LAB)).resolves.toBe('com');
    const b: any = new InfluencerMessagesCronService(prismaCom([{ name: 'fin', purpose: 'FINANCEIRO' }, { name: 'atend', purpose: 'CLINICA' }]), settings);
    await expect(b.chipDoLaboratorio(LAB)).resolves.toBe('atend');
    const c: any = new InfluencerMessagesCronService(prismaCom([{ name: 'fin', purpose: 'FINANCEIRO' }]), settings);
    await expect(c.chipDoLaboratorio(LAB)).resolves.toBeNull();
  });

  it('conta que não é laboratório: undefined (segue o caminho da clínica)', async () => {
    const svc: any = new InfluencerMessagesCronService(prismaCom([{ name: 'com', purpose: 'COMERCIAL' }]), settings);
    await expect(svc.chipDoLaboratorio('conta-clinica-1')).resolves.toBeUndefined();
  });

  it('envia pelo chip da conta; sem chip, registra FAILED e não chama a Evolution', async () => {
    const prisma = prismaCom([]);
    const svc: any = new InfluencerMessagesCronService(prisma, settings);
    await expect(svc.dispatchOne(sch, inf, quando, 'com')).resolves.toBe('SENT');
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendText/com');
    post.mockClear();
    await expect(svc.dispatchOne(sch, inf, quando, null)).resolves.toBe('FAILED');
    expect(post).not.toHaveBeenCalled();
    const { create } = prisma.influencerMessageLog.upsert.mock.calls[1][0];
    expect(create).toMatchObject({ tenant_id: LAB, status: 'FAILED' });
    expect(create.error_message).toMatch(/Laboratório sem WhatsApp/);
  });
});
