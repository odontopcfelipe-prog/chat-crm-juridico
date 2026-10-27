/**
 * F2 parte 4 — vigia diária do laboratório (business-type/lab-sentinel.service.ts
 * e lab-sentinela.ts).
 *
 * Sem laboratório (hoje): só o log '0 laboratórios', nenhuma contagem, nenhum
 * e-mail. Com laboratório: conta cada coisa fora do lugar NA conta dele; acima
 * de zero, AuditLog e 1 e-mail por dia aos SUPER_ADMIN.
 */
import { LabSentinelService } from '../business-type/lab-sentinel.service';
import { contarForaDoLugar, foraDoLugar, TIPOS_DE_AGENDA_DO_LABORATORIO } from '../business-type/lab-sentinela';

const LAB = '00000000-0000-0000-0000-00000000a001';

const MODELOS_CONTADOS = [
  'odontogram', 'toothRecord', 'anamnesis', 'medicalRecord', 'clinicalNote', 'clinicalImage', 'radiographyExam',
  'patientAllergy', 'patientMedication', 'estheticApplication', 'adverseReaction', 'contractSignature', 'contract',
  'treatmentPlan', 'maintenanceTask', 'returnAlert', 'postCareSurvey', 'portalToken', 'smileSimulation', 'referral',
  'affiliateReferral', 'waitlistEntry', 'aiUsage', 'aiMemory', 'commission', 'message', 'calendarEvent', 'paymentGatewayCharge',
];

function prismaFalso(opcoes: {
  labs?: Array<{ tenant_id: string; tenant?: { name: string } }> | Error;
  contagens?: Record<string, number>;
  chips?: string[];
  chaveAsaas?: string | null;
  superAdmins?: string[];
  diaJaReivindicado?: boolean;
} = {}) {
  const p: any = {
    tenantBusinessProfile: {
      findMany: jest.fn(async () => {
        if (opcoes.labs instanceof Error) throw opcoes.labs;
        return opcoes.labs ?? [];
      }),
    },
    instance: { findMany: jest.fn(async () => (opcoes.chips ?? []).map((name) => ({ name }))) },
    tenantSetting: { findUnique: jest.fn(async () => (opcoes.chaveAsaas ? { value: opcoes.chaveAsaas } : null)) },
    globalSetting: {
      updateMany: jest.fn(async (args: any) => ({ count: args.data.value === '' ? 1 : opcoes.diaJaReivindicado ? 0 : 1 })),
      create: jest.fn(async () => {
        if (opcoes.diaJaReivindicado) throw new Error('P2002');
        return {};
      }),
    },
    user: { findMany: jest.fn(async () => (opcoes.superAdmins ?? ['dono@exemplo.test']).map((email) => ({ email }))) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  for (const m of MODELOS_CONTADOS) p[m] = { count: jest.fn(async () => opcoes.contagens?.[m] ?? 0) };
  return p;
}

function montar(prisma: any, enviar: (args: any) => Promise<boolean> = async () => true) {
  const mail: any = { renderTemplate: jest.fn((o: any) => `<html>${o.title}|${o.bodyHtml}</html>`), send: jest.fn(enviar) };
  const svc = new LabSentinelService(prisma, mail);
  const logs: string[] = [];
  (svc as any).logger = { log: (m: string) => logs.push(`log ${m}`), warn: (m: string) => logs.push(`warn ${m}`) };
  return { svc, mail, logs };
}

const todasAsContagens = (prisma: any) => MODELOS_CONTADOS.reduce((n, m) => n + prisma[m].count.mock.calls.length, 0);

beforeEach(() => {
  delete process.env.LAB_SENTINEL_OFF;
  jest.useFakeTimers({ now: new Date('2026-10-27T10:30:00.000Z') });
});
afterEach(() => jest.useRealTimers());

describe('sem laboratório (hoje)', () => {
  it("só registra '0 laboratórios': nenhuma contagem, trava, auditoria ou e-mail", async () => {
    const prisma = prismaFalso();
    const { svc, mail, logs } = montar(prisma);
    await svc.verificar();
    expect(logs).toEqual(['log [LAB-SENTINEL] 0 laboratórios']);
    expect(todasAsContagens(prisma)).toBe(0);
    expect(prisma.globalSetting.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.tenantBusinessProfile.findMany.mock.calls[0][0].where).toEqual({ business_type: 'LABORATORIO' });
  });

  it("falha ao ler a tabela: registra a falha, NÃO diz '0 laboratórios'", async () => {
    const prisma = prismaFalso({ labs: new Error('relation "TenantBusinessProfile" does not exist') });
    const { svc, logs } = montar(prisma);
    await svc.verificar();
    expect(logs.join('\n')).toMatch(/warn \[LAB-SENTINEL\] vigia falhou/);
    expect(logs.join('\n')).not.toMatch(/0 laboratórios/);
  });

  it('LAB_SENTINEL_OFF=1 desliga', async () => {
    process.env.LAB_SENTINEL_OFF = '1';
    const prisma = prismaFalso({ labs: [{ tenant_id: LAB }], contagens: { aiUsage: 3 } });
    const { svc, mail } = montar(prisma);
    await svc.verificar();
    expect(prisma.tenantBusinessProfile.findMany).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('com laboratório', () => {
  it('tudo zero: só log, sem e-mail', async () => {
    const prisma = prismaFalso({ labs: [{ tenant_id: LAB, tenant: { name: 'Lab Teste' } }] });
    const { svc, mail, logs } = montar(prisma);
    await svc.verificar();
    expect(logs).toEqual(['log [LAB-SENTINEL] 1 laboratório(s), nada fora do lugar']);
    expect(MODELOS_CONTADOS.every((m) => prisma[m].count.mock.calls.length >= 1)).toBe(true);
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('acima de zero: AuditLog LAB_SENTINEL na conta e e-mail aos SUPER_ADMIN com a lista', async () => {
    const prisma = prismaFalso({
      labs: [{ tenant_id: LAB, tenant: { name: 'Lab <Teste>' } }],
      contagens: { aiUsage: 2, odontogram: 1 },
      superAdmins: ['dono@exemplo.test', 'dono@exemplo.test', 'outro@exemplo.test'],
    });
    const { svc, mail, logs } = montar(prisma);
    await svc.verificar();
    expect(logs.some((l) => l.startsWith(`warn [LAB-SENTINEL] ${LAB}`))).toBe(true);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: LAB,
      entity: 'LABORATORIO',
      entity_id: LAB,
      action: 'LAB_SENTINEL',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data.meta_json.contagens).toEqual({ Odontograma: 1, 'Uso de IA': 2 });
    expect(mail.send.mock.calls.map((c: any) => c[0].to).sort()).toEqual(['dono@exemplo.test', 'outro@exemplo.test']);
    const html = mail.send.mock.calls[0][0].html as string;
    expect(html).toContain('Uso de IA: <b>2</b>');
    expect(html).toContain('Lab &lt;Teste&gt;');
    expect(prisma.globalSetting.updateMany.mock.calls[0][0]).toEqual({
      where: { key: 'LAB_SENTINEL_DIA', value: { not: '2026-10-27' } },
      data: { value: '2026-10-27' },
    });
  });

  it('segunda réplica no mesmo dia: não repete auditoria nem e-mail', async () => {
    const prisma = prismaFalso({ labs: [{ tenant_id: LAB }], contagens: { aiUsage: 1 }, diaJaReivindicado: true });
    const { svc, mail } = montar(prisma);
    await svc.verificar();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('nenhum e-mail saiu: devolve a trava do dia', async () => {
    const prisma = prismaFalso({ labs: [{ tenant_id: LAB }], contagens: { aiUsage: 1 } });
    const { svc } = montar(prisma, async () => false);
    await svc.verificar();
    expect(prisma.globalSetting.updateMany).toHaveBeenLastCalledWith({
      where: { key: 'LAB_SENTINEL_DIA', value: '2026-10-27' },
      data: { value: '' },
    });
  });

  it('sem SUPER_ADMIN com e-mail: avisa no log e devolve a trava', async () => {
    const prisma = prismaFalso({ labs: [{ tenant_id: LAB }], contagens: { aiUsage: 1 }, superAdmins: [] });
    const { svc, logs } = montar(prisma);
    await svc.verificar();
    expect(logs).toContain('warn [LAB-SENTINEL] nenhum SUPER_ADMIN com e-mail para avisar');
    expect(prisma.globalSetting.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { value: '' } }));
  });
});

describe('contarForaDoLugar — cada contagem olha só a conta do laboratório', () => {
  it('todo where cita o id do laboratório', async () => {
    const prisma = prismaFalso({ chips: ['lab-chip'] });
    await contarForaDoLugar(prisma, LAB);
    for (const m of MODELOS_CONTADOS) {
      for (const [args] of prisma[m].count.mock.calls) expect(JSON.stringify(args.where)).toContain(LAB);
    }
  });

  it('agenda: conta todo tipo fora de TAREFA / OUTRO / BLOQUEIO', async () => {
    const prisma = prismaFalso();
    await contarForaDoLugar(prisma, LAB);
    expect(prisma.calendarEvent.count).toHaveBeenCalledWith({
      where: { tenant_id: LAB, type: { notIn: ['TAREFA', 'OUTRO', 'BLOQUEIO'] } },
    });
    expect(TIPOS_DE_AGENDA_DO_LABORATORIO).not.toContain('CONSULTA');
  });

  it('chips: sem chip próprio não procura conversa de outra conta pelo chip; com chip, procura', async () => {
    const sem = prismaFalso({ chips: [] });
    await contarForaDoLugar(sem, LAB);
    expect(sem.message.count).toHaveBeenCalledTimes(2); // IA + chip de outra conta
    const com = prismaFalso({ chips: ['lab-chip'] });
    await contarForaDoLugar(com, LAB);
    expect(com.message.count).toHaveBeenCalledTimes(3);
    expect(com.message.count).toHaveBeenCalledWith({
      where: {
        instance_name: { in: ['lab-chip'] },
        direction: 'out',
        conversation: { OR: [{ tenant_id: null }, { tenant_id: { not: LAB } }] },
      },
    });
  });

  it('Asaas: com chave própria não conta; sem chave, conta as cobranças ASAAS da conta', async () => {
    const com = prismaFalso({ chaveAsaas: '$aact_x' });
    const r1 = await contarForaDoLugar(com, LAB);
    expect(com.paymentGatewayCharge.count).not.toHaveBeenCalled();
    expect(r1['Cobrança Asaas sem a chave do próprio laboratório']).toBe(0);
    const sem = prismaFalso({ chaveAsaas: '  ', contagens: { paymentGatewayCharge: 4 } });
    const r2 = await contarForaDoLugar(sem, LAB);
    expect(sem.paymentGatewayCharge.count).toHaveBeenCalledWith({ where: { tenant_id: LAB, gateway: 'ASAAS' } });
    expect(r2['Cobrança Asaas sem a chave do próprio laboratório']).toBe(4);
  });

  it('foraDoLugar deixa só o que passou de zero', () => {
    expect(foraDoLugar({ a: 0, b: 2, c: 0 })).toEqual({ b: 2 });
  });
});
