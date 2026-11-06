/**
 * Encaminhamento do arquivo do contato triado aos administradores
 * (EvolutionService.forwardNonPatientAttachment) com a conta de laboratório suspensa ou
 * congelada: o arquivo fica na conversa e nada sai pelo chip da conta.
 *
 * Sem banco: o Prisma é um dublê; dados de exemplo (repositório público).
 */
import { Logger } from '@nestjs/common';
import { NAO_PACIENTE_ANEXO_JANELA_MS, __limparCacheLabTenants, naoPacienteTriageKey } from '@crm/shared';
import { loadAdminAlertRecipients } from '../common/utils/admin-alert-recipients';
import { EvolutionService } from './evolution.service';

jest.mock('../common/utils/admin-alert-recipients', () => ({
  loadAdminAlertRecipients: jest.fn(async () => [{ phone: '5582900000099', userId: null, nome: 'ADM Exemplo' }]),
}));

const LAB = 'conta-lab-exemplo';
const CLINICA = 'conta-clinica-exemplo';

function montar(conta: string, status: string) {
  const agora = Date.now();
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    lead: {
      findUnique: jest.fn(async () => ({
        name: 'Contato Exemplo', phone: '5582900000001', is_client: false, non_patient_category: 'FORNECEDOR', non_patient_at: new Date(agora - 60_000),
      })),
    },
    instance: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => [{ name: 'chip-da-conta', purpose: 'COMERCIAL' }]) },
    patient: { findFirst: jest.fn(async () => null) },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (where.key === naoPacienteTriageKey(conta) ? { value: 'true' } : null)),
      findMany: jest.fn(async () => []),
    },
    tenant: { findUnique: jest.fn(async () => ({ status })) },
    auditLog: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
    media: { findUnique: jest.fn(async () => null) },
    dispatchLog: { create: jest.fn(async () => ({})) },
  };
  const whatsappService: any = { sendText: jest.fn(async () => ({ key: { id: 'wamid-1' } })), sendMedia: jest.fn() };
  const svc: any = Object.create(EvolutionService.prototype);
  Object.assign(svc, { prisma, whatsappService, logger: new Logger('teste'), moduleRef: { get: jest.fn() } });
  const ctx = {
    messageId: 'msg-1', messageCreatedAt: new Date(agora), leadId: 'lead-1', tenantId: conta, msgType: 'document', caption: null, fileNameHint: null, instanceName: null,
  };
  return { svc, prisma, whatsappService, ctx };
}

beforeEach(() => {
  __limparCacheLabTenants();
  (loadAdminAlertRecipients as jest.Mock).mockClear();
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

describe('arquivo do contato triado, com a conta suspensa', () => {
  it('a janela do encaminhamento continua valendo para o dublê', () => {
    expect(NAO_PACIENTE_ANEXO_JANELA_MS).toBeGreaterThan(60_000);
  });

  it.each(['SUSPENDED', 'DELETED'])('laboratório %s: não marca, não baixa e não envia', async (status) => {
    const m = montar(LAB, status);
    await m.svc.forwardNonPatientAttachment(Promise.resolve(false), m.ctx);
    expect(m.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(m.whatsappService.sendText).not.toHaveBeenCalled();
  });

  it('laboratório ativo: encaminha', async () => {
    const m = montar(LAB, 'ACTIVE');
    await m.svc.forwardNonPatientAttachment(Promise.resolve(false), m.ctx);
    expect(m.whatsappService.sendText).toHaveBeenCalledTimes(1);
  });

  it('clínica: não lê o status da conta e encaminha como sempre', async () => {
    const m = montar(CLINICA, 'SUSPENDED');
    await m.svc.forwardNonPatientAttachment(Promise.resolve(false), m.ctx);
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(m.whatsappService.sendText).toHaveBeenCalledTimes(1);
  });
});
