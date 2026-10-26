/**
 * Horário da clínica (PUT /settings/office-hours) e servidor do WhatsApp
 * (POST /settings/whatsapp-config): com clínica no usuário gravam na dela (como
 * antes); sem clínica, só o SUPER_ADMIN grava o padrão global — o ADMIN sem
 * clínica recebe 403 PERMISSION_DENIED e nada é gravado.
 * (O liga/desliga por chip sem clínica está em ia-config-por-conta.spec.ts.)
 */
import { ForbiddenException, Logger } from '@nestjs/common';
import { SettingsController } from '../settings/settings.controller';

const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const ADMIN_A = { id: 'u-a', roles: ['ADMIN'], tenant_id: A };
const ADMIN_B = { id: 'u-b', roles: ['ADMIN'], tenant_id: B };
const ADMIN_SEM_CONTA = { id: 'u-x', roles: ['ADMIN'], tenant_id: null };
const ADMIN_CONTA_VAZIA = { id: 'u-y', roles: ['ADMIN'], tenant_id: '' };
const DONO = { id: 'u-dono', roles: ['ADMIN', 'SUPER_ADMIN'], tenant_id: A };
const SUPER_SEM_CONTA = { id: 'u-s', roles: ['SUPER_ADMIN', 'ADMIN'], tenant_id: null };

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});

function montar() {
  const service: any = {
    upsert: jest.fn(async () => ({})),
    setWhatsAppConfig: jest.fn(async () => undefined),
  };
  const whatsapp: any = {
    listInstances: jest.fn(async () => [{ instanceName: 'chip-1' }]),
    setWebhook: jest.fn(async () => undefined),
  };
  const prisma: any = { tenantSetting: { upsert: jest.fn(async () => ({})) } };
  const ctl = new SettingsController(service, whatsapp, {} as any, prisma, {} as any);
  return { ctl, service, whatsapp, prisma };
}

const req = (user: any) => ({ user });
const negado = (e: any) => {
  expect(e).toBeInstanceOf(ForbiddenException);
  expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
};

const HORARIO = { ai_enabled: true, open_time: '08:00', close_time: '18:00', business_days: [1, 2, 3, 4, 5], timezone: 'America/Maceio' };
const WHATS = { apiUrl: 'https://evo.exemplo', apiKey: 'chave-evo-teste', webhookUrl: 'https://api.exemplo/webhooks/evolution' };

describe('Escrita global só pelo SUPER_ADMIN quando o usuário não tem clínica', () => {
  describe('a clínica grava só na dela', () => {
    it('horário: ADMIN da B grava na TenantSetting da B (nunca a global)', async () => {
      const { ctl, service, prisma } = montar();
      expect(await ctl.saveOfficeHours(req(ADMIN_B), HORARIO)).toEqual({ message: 'Horário da clínica salvo' });
      expect(service.upsert).not.toHaveBeenCalled();
      const contas = prisma.tenantSetting.upsert.mock.calls.map((c: any[]) => c[0].where.tenant_id_key.tenant_id);
      expect(contas.length).toBe(5);
      expect(new Set(contas)).toEqual(new Set([B]));
    });

    it('WhatsApp: ADMIN da A salva na A e reaplica o webhook só nos chips da A', async () => {
      const { ctl, service, whatsapp } = montar();
      await ctl.setWhatsAppConfig(req(ADMIN_A), WHATS);
      expect(service.setWhatsAppConfig).toHaveBeenCalledWith(WHATS.apiUrl, WHATS.apiKey, WHATS.webhookUrl, A);
      expect(whatsapp.listInstances).toHaveBeenCalledWith(A);
      expect(whatsapp.setWebhook).toHaveBeenCalledWith('chip-1', WHATS.webhookUrl, A);
    });
  });

  describe('ADMIN sem clínica: 403, nada gravado', () => {
    it.each([ADMIN_SEM_CONTA, ADMIN_CONTA_VAZIA])('horário (%o)', async (u) => {
      const { ctl, service, prisma } = montar();
      negado(await ctl.saveOfficeHours(req(u), HORARIO).catch((e) => e));
      expect(service.upsert).not.toHaveBeenCalled();
      expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
    });

    it.each([ADMIN_SEM_CONTA, ADMIN_CONTA_VAZIA])('WhatsApp (%o)', async (u) => {
      const { ctl, service, whatsapp } = montar();
      negado(await ctl.setWhatsAppConfig(req(u), WHATS).catch((e) => e));
      expect(service.setWhatsAppConfig).not.toHaveBeenCalled();
      expect(whatsapp.setWebhook).not.toHaveBeenCalled();
    });
  });

  describe('o dono e o SUPER_ADMIN sem clínica', () => {
    it('dono (SUPER_ADMIN com clínica): grava na clínica dele, como antes', async () => {
      const { ctl, service, prisma } = montar();
      await ctl.saveOfficeHours(req(DONO), HORARIO);
      await ctl.setWhatsAppConfig(req(DONO), WHATS);
      expect(service.upsert).not.toHaveBeenCalled();
      expect(prisma.tenantSetting.upsert.mock.calls.every((c: any[]) => c[0].where.tenant_id_key.tenant_id === A)).toBe(true);
      expect(service.setWhatsAppConfig).toHaveBeenCalledWith(WHATS.apiUrl, WHATS.apiKey, WHATS.webhookUrl, A);
    });

    it('SUPER_ADMIN sem clínica: grava o padrão global, como antes', async () => {
      const { ctl, service, prisma } = montar();
      await ctl.saveOfficeHours(req(SUPER_SEM_CONTA), HORARIO);
      expect(service.upsert.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(
        ['AFTER_HOURS_AI_ENABLED', 'AFTER_HOURS_END', 'AFTER_HOURS_START', 'BUSINESS_DAYS', 'TIMEZONE'].sort(),
      );
      expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
      await ctl.setWhatsAppConfig(req(SUPER_SEM_CONTA), WHATS);
      expect(service.setWhatsAppConfig).toHaveBeenCalledWith(WHATS.apiUrl, WHATS.apiKey, WHATS.webhookUrl, null);
    });
  });
});
