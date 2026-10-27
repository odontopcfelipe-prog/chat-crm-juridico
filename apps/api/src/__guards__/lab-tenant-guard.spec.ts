/**
 * F2 parte 4 — LabTenantGuard (apps/api/src/business-type/lab-tenant.guard.ts).
 *
 * Clínica: passa sempre, e com o cache quente sem nenhuma consulta (nem a da
 * conta congelada, nem auditoria). Laboratório: só alcança os handlers da
 * política de rotas; o resto é 403 VERTICAL_DENIED; conta congelada é 403
 * TENANT_INACTIVE mesmo com o token antigo.
 */
import { ForbiddenException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { LabTenantGuard } from '../business-type/lab-tenant.guard';
import { __limparCacheCongelamento } from '../business-type/lab-congelamento';
import { ROTAS_DO_LABORATORIO } from '../business-type/lab-route-policy';

const CLINICA = '00000000-0000-0000-0000-0000000c1001';
const LAB = '00000000-0000-0000-0000-00000000a001';
const OUTRO_LAB = '00000000-0000-0000-0000-00000000a002';

// Handlers de verdade: 'UsersController.getMe' é chamado pelo layout em toda página
// (tem de estar liberado); 'OdontogramController.upsertTooth' é de clínica.
class UsersController {
  getMe() {}
}
class OdontogramController {
  upsertTooth() {}
  outroMetodoNovo() {}
}

type Montagem = {
  guard: LabTenantGuard;
  prisma: any;
  avisos: string[];
};

function montar(opcoes: {
  labs?: string[];
  status?: string;
  chaves?: Array<{ key: string; value: string }>;
  falhaCongelamento?: boolean;
} = {}): Montagem {
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => (opcoes.labs ?? []).map((tenant_id) => ({ tenant_id }))) },
    tenant: {
      findUnique: jest.fn(async () => {
        if (opcoes.falhaCongelamento) throw new Error('banco fora');
        return { status: opcoes.status ?? 'ACTIVE' };
      }),
    },
    globalSetting: {
      findMany: jest.fn(async (args: any) => (opcoes.chaves ?? []).filter((c) => args.where.key.in.includes(c.key))),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const guard = new LabTenantGuard(prisma);
  const avisos: string[] = [];
  (guard as any).logger = { warn: (m: string) => avisos.push(m), log: () => undefined };
  return { guard, prisma, avisos };
}

function contexto(user: any, classe: any, handler: any, tipo = 'http'): any {
  return {
    getType: () => tipo,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getClass: () => classe,
    getHandler: () => handler,
  };
}

const usuario = (tenant_id: string | null | undefined, roles = ['ADMIN']) => ({ id: 'u1', email: 'a@b.c', roles, tenant_id });

async function resultado(p: Promise<boolean>): Promise<['ok', boolean] | ['erro', any]> {
  try {
    return ['ok', await p];
  } catch (e: any) {
    return ['erro', e];
  }
}

function codigo(e: any): string | undefined {
  return e instanceof ForbiddenException ? (e.getResponse() as any)?.code : undefined;
}

const nenhumaConsulta = (prisma: any) => {
  expect(prisma.tenantBusinessProfile.findMany).not.toHaveBeenCalled();
  expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  expect(prisma.globalSetting.findMany).not.toHaveBeenCalled();
  expect(prisma.auditLog.create).not.toHaveBeenCalled();
};

beforeEach(() => {
  __limparCacheLabTenants();
  __limparCacheCongelamento();
  jest.useFakeTimers({ now: new Date('2026-10-26T15:00:00.000Z') });
});
afterEach(() => jest.useRealTimers());

it('os handlers usados no teste existem como esperado na política', () => {
  expect(ROTAS_DO_LABORATORIO.has('UsersController.getMe')).toBe(true);
  expect(ROTAS_DO_LABORATORIO.has('OdontogramController.upsertTooth')).toBe(false);
});

describe('clínica — caminho de hoje', () => {
  it('passa em qualquer handler, inclusive de clínica', async () => {
    const m = montar({ labs: [LAB] });
    for (const [classe, h] of [[UsersController, UsersController.prototype.getMe], [OdontogramController, OdontogramController.prototype.upsertTooth]] as const) {
      expect(await m.guard.canActivate(contexto(usuario(CLINICA), classe, h))).toBe(true);
    }
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(m.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('com o cache quente: zero consulta', async () => {
    const m = montar({ labs: [LAB] });
    await m.guard.canActivate(contexto(usuario(CLINICA), OdontogramController, OdontogramController.prototype.upsertTooth));
    m.prisma.tenantBusinessProfile.findMany.mockClear();
    for (let i = 0; i < 5; i++) {
      expect(await m.guard.canActivate(contexto(usuario(CLINICA), OdontogramController, OdontogramController.prototype.upsertTooth))).toBe(true);
    }
    nenhumaConsulta(m.prisma);
  });

  it('sem laboratório nenhum (hoje): passa, com 1 leitura da lista por minuto no máximo', async () => {
    const m = montar({ labs: [] });
    for (let i = 0; i < 3; i++) {
      expect(await m.guard.canActivate(contexto(usuario(CLINICA), OdontogramController, OdontogramController.prototype.upsertTooth))).toBe(true);
    }
    expect(m.prisma.tenantBusinessProfile.findMany).toHaveBeenCalledTimes(1);
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('clínica SUSPENSA não é barrada pelo guard (só o login barra, como hoje)', async () => {
    const m = montar({ labs: [LAB], status: 'SUSPENDED', chaves: [{ key: 'LAB_FREEZE', value: 'true' }] });
    expect(await m.guard.canActivate(contexto(usuario(CLINICA), UsersController, UsersController.prototype.getMe))).toBe(true);
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('rota pública, usuário sem conta e contexto que não é http passam sem consulta', async () => {
    const m = montar({ labs: [LAB] });
    expect(await m.guard.canActivate(contexto(undefined, OdontogramController, OdontogramController.prototype.upsertTooth))).toBe(true);
    for (const t of [null, undefined, '']) {
      expect(await m.guard.canActivate(contexto(usuario(t as any), OdontogramController, OdontogramController.prototype.upsertTooth))).toBe(true);
    }
    expect(await m.guard.canActivate(contexto(usuario(LAB), OdontogramController, OdontogramController.prototype.upsertTooth, 'ws'))).toBe(true);
    nenhumaConsulta(m.prisma);
  });

  it('falha ao ler a lista de laboratórios: trata como clínica e avisa', async () => {
    const m = montar();
    m.prisma.tenantBusinessProfile.findMany.mockRejectedValue(new Error('banco fora'));
    expect(await m.guard.canActivate(contexto(usuario(CLINICA), OdontogramController, OdontogramController.prototype.upsertTooth))).toBe(true);
    expect(m.avisos.join('\n')).toMatch(/\[lab-tenants\] falha/);
  });
});

describe('laboratório — negação por padrão', () => {
  it('handler da política passa', async () => {
    const m = montar({ labs: [LAB] });
    expect(await m.guard.canActivate(contexto(usuario(LAB), UsersController, UsersController.prototype.getMe))).toBe(true);
    expect(m.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('handler de clínica: 403 VERTICAL_DENIED, log e auditoria', async () => {
    const m = montar({ labs: [LAB] });
    const r = await resultado(m.guard.canActivate(contexto(usuario(LAB), OdontogramController, OdontogramController.prototype.upsertTooth)));
    expect(r[0]).toBe('erro');
    expect(codigo(r[1])).toBe('VERTICAL_DENIED');
    expect(m.avisos).toContain(`[VERTICAL_DENIED] ${LAB} OdontogramController.upsertTooth`);
    expect(m.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: LAB,
      actor_user_id: 'u1',
      entity: 'LABORATORIO',
      entity_id: 'OdontogramController.upsertTooth',
      action: 'VERTICAL_DENIED',
    });
  });

  it('handler NOVO (fora de qualquer lista) nasce negado', async () => {
    const m = montar({ labs: [LAB] });
    const r = await resultado(m.guard.canActivate(contexto(usuario(LAB), OdontogramController, OdontogramController.prototype.outroMetodoNovo)));
    expect(codigo(r[1])).toBe('VERTICAL_DENIED');
  });

  it('auditoria: no máximo 1 por conta × handler × hora', async () => {
    const m = montar({ labs: [LAB, OUTRO_LAB] });
    const negar = (t: string, h: any) => resultado(m.guard.canActivate(contexto(usuario(t), OdontogramController, h)));
    await negar(LAB, OdontogramController.prototype.upsertTooth);
    await negar(LAB, OdontogramController.prototype.upsertTooth);
    expect(m.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    await negar(LAB, OdontogramController.prototype.outroMetodoNovo);
    await negar(OUTRO_LAB, OdontogramController.prototype.upsertTooth);
    expect(m.prisma.auditLog.create).toHaveBeenCalledTimes(3);
    jest.setSystemTime(new Date('2026-10-26T16:00:01.000Z'));
    __limparCacheLabTenants();
    await negar(LAB, OdontogramController.prototype.upsertTooth);
    expect(m.prisma.auditLog.create).toHaveBeenCalledTimes(4);
  });

  it('auditoria que falha não muda a resposta (continua 403 VERTICAL_DENIED)', async () => {
    const m = montar({ labs: [LAB] });
    m.prisma.auditLog.create.mockRejectedValue(new Error('banco fora'));
    const r = await resultado(m.guard.canActivate(contexto(usuario(LAB), OdontogramController, OdontogramController.prototype.upsertTooth)));
    expect(codigo(r[1])).toBe('VERTICAL_DENIED');
  });

  it('o SUPER_ADMIN dentro da conta de laboratório também segue a política', async () => {
    const m = montar({ labs: [LAB] });
    const sa = usuario(LAB, ['SUPER_ADMIN', 'ADMIN']);
    expect(await m.guard.canActivate(contexto(sa, UsersController, UsersController.prototype.getMe))).toBe(true);
    const r = await resultado(m.guard.canActivate(contexto(sa, OdontogramController, OdontogramController.prototype.upsertTooth)));
    expect(codigo(r[1])).toBe('VERTICAL_DENIED');
  });
});

describe('laboratório congelado — 403 TENANT_INACTIVE mesmo com token antigo', () => {
  const casos: Array<[string, Parameters<typeof montar>[0]]> = [
    ['conta SUSPENDED', { status: 'SUSPENDED' }],
    ['conta DELETED', { status: 'DELETED' }],
    ['LAB_FREEZE = true (todos)', { chaves: [{ key: 'LAB_FREEZE', value: 'true' }] }],
    ['LAB_FREEZE_<conta> = true', { chaves: [{ key: `LAB_FREEZE_${LAB}`, value: ' TRUE ' }] }],
  ];
  it.each(casos)('%s: até handler liberado recusa', async (_n, opcoes) => {
    const m = montar({ labs: [LAB], ...opcoes });
    const r = await resultado(m.guard.canActivate(contexto(usuario(LAB), UsersController, UsersController.prototype.getMe)));
    expect(r[0]).toBe('erro');
    expect(codigo(r[1])).toBe('TENANT_INACTIVE');
    expect(m.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('congelar OUTRO laboratório, LAB_FREEZE false ou conta TRIAL/ACTIVE não congela', async () => {
    for (const opcoes of [
      { chaves: [{ key: `LAB_FREEZE_${OUTRO_LAB}`, value: 'true' }] },
      { chaves: [{ key: 'LAB_FREEZE', value: 'false' }] },
      { status: 'TRIAL' },
      { status: 'ACTIVE' },
    ]) {
      __limparCacheLabTenants();
      __limparCacheCongelamento();
      const m = montar({ labs: [LAB], ...opcoes });
      expect(await m.guard.canActivate(contexto(usuario(LAB), UsersController, UsersController.prototype.getMe))).toBe(true);
    }
  });

  it('SUPER_ADMIN não é congelado (como no login), mas segue a política', async () => {
    const m = montar({ labs: [LAB], status: 'SUSPENDED' });
    const sa = usuario(LAB, ['SUPER_ADMIN']);
    expect(await m.guard.canActivate(contexto(sa, UsersController, UsersController.prototype.getMe))).toBe(true);
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
    const r = await resultado(m.guard.canActivate(contexto(sa, OdontogramController, OdontogramController.prototype.upsertTooth)));
    expect(codigo(r[1])).toBe('VERTICAL_DENIED');
  });

  it('a leitura do congelamento tem cache de 60 s por conta', async () => {
    const m = montar({ labs: [LAB] });
    const chamar = () => m.guard.canActivate(contexto(usuario(LAB), UsersController, UsersController.prototype.getMe));
    await chamar();
    await chamar();
    expect(m.prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    expect(m.prisma.globalSetting.findMany).toHaveBeenCalledTimes(1);
    // suspensa no meio: vale na próxima leitura (até 60 s)
    m.prisma.tenant.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
    jest.setSystemTime(new Date('2026-10-26T15:00:59.000Z'));
    expect(await chamar()).toBe(true);
    jest.setSystemTime(new Date('2026-10-26T15:01:01.000Z'));
    const r = await resultado(chamar());
    expect(codigo(r[1])).toBe('TENANT_INACTIVE');
    expect(m.prisma.tenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it('falha ao ler o congelamento: não congela, avisa e a política continua valendo', async () => {
    const m = montar({ labs: [LAB], falhaCongelamento: true });
    expect(await m.guard.canActivate(contexto(usuario(LAB), UsersController, UsersController.prototype.getMe))).toBe(true);
    expect(m.avisos.join('\n')).toMatch(/\[lab-congelamento\] falha/);
    const r = await resultado(m.guard.canActivate(contexto(usuario(LAB), OdontogramController, OdontogramController.prototype.upsertTooth)));
    expect(codigo(r[1])).toBe('VERTICAL_DENIED');
  });
});

describe('LabTenantGuard — tipo no token', () => {
  beforeEach(() => {
    __limparCacheLabTenants();
    __limparCacheCongelamento();
  });

  it('token de laboratório (bt) é tratado como laboratório mesmo antes de o cache ver a conta', async () => {
    const m = montar({ labs: [] });
    const user = { ...usuario(LAB), bt: 'LABORATORIO' };
    const [tipo, erro] = await resultado(m.guard.canActivate(contexto(user, OdontogramController, OdontogramController.prototype.upsertTooth)));
    expect(tipo).toBe('erro');
    expect(codigo(erro)).toBe('VERTICAL_DENIED');
    await expect(m.guard.canActivate(contexto(user, UsersController, UsersController.prototype.getMe))).resolves.toBe(true);
  });

  it('token de clínica (sem bt, ou bt diferente do literal) passa como hoje, sem consulta a mais', async () => {
    const m = montar({ labs: [] });
    for (const bt of [undefined, 'CLINICA', 'laboratorio', '']) {
      await expect(
        m.guard.canActivate(contexto({ ...usuario(CLINICA), bt }, OdontogramController, OdontogramController.prototype.upsertTooth)),
      ).resolves.toBe(true);
    }
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});
