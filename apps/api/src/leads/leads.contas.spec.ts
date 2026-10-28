/**
 * Leads e notas do lead: cada conta só lê, altera ou liga lead da própria conta.
 *
 *  - lead de outra conta e lead sem conta (tenant_id NULL) → recusado, nada gravado;
 *  - lead da própria conta → as mesmas chamadas e argumentos de antes;
 *  - SUPER_ADMIN sem conta (tenantId undefined) → como antes;
 *  - id que não existe → como antes;
 *  - PATCH /leads/:id/stage só aceita etapa de funil da própria conta (funil legado
 *    sem conta segue aceito na clínica; no laboratório, não).
 */
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { LeadsService } from './leads.service';
import { LeadsController } from './leads.controller';
import { LeadNotesService } from './lead-notes.service';
import { LeadNotesController } from './lead-notes.controller';

const A = 'conta-a';
const B = 'conta-b';
const LAB = 'conta-lab';

const LEADS: Record<string, any> = {
  LA: { id: 'LA', tenant_id: A, stage: 'NOVO', is_client: false, name: 'Maria Exemplo', conversations: [] },
  LB: { id: 'LB', tenant_id: B, stage: 'NOVO', is_client: false, name: 'Outra Conta', conversations: [] },
  L0: { id: 'L0', tenant_id: null, stage: 'NOVO', is_client: false, name: 'Sem Conta', conversations: [] },
  LLAB: { id: 'LLAB', tenant_id: LAB, stage: 'NOVO', is_client: false, name: 'Lab Exemplo', conversations: [] },
};

const STAGES: Record<string, any> = {
  stA: { id: 'stA', slug: 'qualificando', is_initial: false, is_won: false, is_lost: false, pipeline_id: 'pA', pipeline: { tenant_id: A } },
  stB: { id: 'stB', slug: 'qualificando', is_initial: false, is_won: false, is_lost: false, pipeline_id: 'pB', pipeline: { tenant_id: B } },
  st0: { id: 'st0', slug: 'qualificando', is_initial: false, is_won: false, is_lost: false, pipeline_id: 'p0', pipeline: { tenant_id: null } },
};

const NOTES: Record<string, any> = {
  nA: { id: 'nA', lead_id: 'LA', user_id: 'autor-a', text: 'nota' },
  nB: { id: 'nB', lead_id: 'LB', user_id: 'autor-b', text: 'nota' },
  n0: { id: 'n0', lead_id: 'L0', user_id: 'autor-0', text: 'nota' },
};

/**
 * Devolve só o que a consulta pediu, como o Prisma: `select` lista os campos (e as
 * relações com o próprio select); `include` soma relações aos campos simples; sem
 * os dois, só os campos simples. Assim um campo que sair do select some aqui também.
 */
const ehRelacao = (v: any) =>
  v !== null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);
function projetar(row: any, args: { select?: any; include?: any } = {}): any {
  if (row == null) return row;
  if (Array.isArray(row)) return row.map((r) => projetar(r, args));
  const out: any = {};
  if (args.select) {
    for (const [k, pedido] of Object.entries<any>(args.select)) {
      if (!pedido || !(k in row)) continue;
      out[k] = pedido === true ? (ehRelacao(row[k]) ? projetar(row[k]) : row[k]) : projetar(row[k], pedido);
    }
    return out;
  }
  for (const [k, v] of Object.entries(row)) if (!ehRelacao(v)) out[k] = v;
  for (const [k, pedido] of Object.entries<any>(args.include ?? {})) {
    if (!pedido || !(k in row)) continue;
    out[k] = pedido === true ? projetar(row[k]) : projetar(row[k], pedido);
  }
  return out;
}

const ESCRITAS = [
  'lead.update', 'lead.updateMany', 'lead.create', 'leadNote.create', 'leadNote.delete',
  'aiMemory.deleteMany', 'aiMemory.create', 'aiMemory.update', 'leadStageHistory.create',
  'conversation.update', 'conversation.updateMany',
];

function banco(labs: string[] = []) {
  const ops: Array<[string, any]> = [];
  const fn = (nome: string, impl: (a: any) => any) =>
    jest.fn(async (a: any) => {
      ops.push([nome, a]);
      return impl(a);
    });
  const prisma: any = {
    lead: {
      findUnique: fn('lead.findUnique', (a) => (LEADS[a.where.id] ? { ...LEADS[a.where.id] } : null)),
      findMany: fn('lead.findMany', () => []),
      count: fn('lead.count', () => 0),
      update: fn('lead.update', (a) => ({ ...(LEADS[a.where.id] ?? { id: a.where.id }), ...a.data })),
      updateMany: fn('lead.updateMany', () => ({ count: 1 })),
    },
    user: { findUnique: fn('user.findUnique', () => ({ roles: ['ADMIN'], inboxes: [] })) },
    pipelineStage: {
      // Respeita o select: a conta do funil só chega se a consulta pedir pipeline.tenant_id.
      findUnique: fn('pipelineStage.findUnique', (a) => projetar(STAGES[a.where.id] ?? null, a)),
      findFirst: fn('pipelineStage.findFirst', () => null),
      findMany: fn('pipelineStage.findMany', () => []),
    },
    conversation: {
      findFirst: fn('conversation.findFirst', () => null),
      updateMany: fn('conversation.updateMany', () => ({ count: 0 })),
      update: fn('conversation.update', () => ({})),
    },
    leadStageHistory: {
      create: fn('leadStageHistory.create', () => ({})),
      findMany: fn('leadStageHistory.findMany', () => []),
    },
    leadNote: {
      findMany: fn('leadNote.findMany', () => []),
      findUnique: fn('leadNote.findUnique', (a) => NOTES[a.where.id] ?? null),
      create: fn('leadNote.create', (a) => ({ id: 'nova', ...a.data })),
      delete: fn('leadNote.delete', () => ({})),
    },
    aiMemory: {
      findUnique: fn('aiMemory.findUnique', () => null),
      deleteMany: fn('aiMemory.deleteMany', () => ({ count: 0 })),
      create: fn('aiMemory.create', () => ({})),
      update: fn('aiMemory.update', () => ({})),
    },
    tenantBusinessProfile: {
      findMany: fn('tenantBusinessProfile.findMany', () => labs.map((tenant_id) => ({ tenant_id }))),
    },
  };
  prisma.$transaction = jest.fn(async (input: any) => (Array.isArray(input) ? Promise.all(input) : input(prisma)));
  const de = (nome: string) => ops.filter(([n]) => n === nome).map(([, a]) => a);
  const escritas = () => ops.filter(([n]) => ESCRITAS.includes(n)).map(([n]) => n);
  return { prisma, ops, de, escritas };
}

function montar(labs: string[] = []) {
  const b = banco(labs);
  const chatGateway = { emitConversationsUpdate: jest.fn(), emitNewLeadNotification: jest.fn(async () => undefined) };
  const automations = { onStageChange: jest.fn(async () => undefined), onNewLead: jest.fn(async () => undefined) };
  const moduleRef = { get: () => undefined };
  const drive = { isConfigured: jest.fn(async () => false) };
  const svc = new LeadsService(b.prisma, chatGateway as any, automations as any, moduleRef as any, drive as any);
  const ctl = new LeadsController(svc, {} as any);
  const notas = new LeadNotesService(b.prisma);
  const notasCtl = new LeadNotesController(notas);
  return { svc, ctl, notas, notasCtl, ...b };
}

const esperar = () => new Promise((r) => setImmediate(r));
const req = (tenant_id?: string, extra: any = {}) => ({ user: { id: 'u-1', roles: ['OPERADOR'], role: 'OPERADOR', tenant_id, ...extra } });

beforeEach(() => __limparCacheLabTenants());

describe('LeadsService.findAll — só leads da própria conta', () => {
  it('conta A: where só com a conta (lead sem conta fica de fora)', async () => {
    const m = montar();
    await m.svc.findAll(A);
    expect(m.de('lead.findMany')[0].where).toEqual({ tenant_id: A, stage: { not: 'PERDIDO' } });
  });

  it('conta A com crc, busca e paginação: mesmo where de antes, sem OR com null', async () => {
    const m = montar();
    await m.svc.findAll(A, undefined, 1, 20, 'maria', undefined, undefined, undefined, true);
    const where = m.de('lead.findMany')[0].where;
    expect(where.tenant_id).toBe(A);
    expect(where.OR).toBeUndefined();
    expect(where.stage).toEqual({ not: 'PERDIDO' });
    expect(where.AND).toEqual([
      { OR: [
        { name: { contains: 'maria', mode: 'insensitive' } },
        { phone: { contains: 'maria' } },
        { email: { contains: 'maria', mode: 'insensitive' } },
      ] },
      { OR: [
        { conversations: { none: {} } },
        { conversations: { some: { NOT: { inbox: { purpose: 'FINANCEIRO' } } } } },
      ] },
    ]);
    expect(m.de('lead.count')[0].where).toBe(where);
  });

  it('coluna Perdidos da conta A: só a conta', async () => {
    const m = montar();
    await m.svc.findAll(A, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true, true);
    expect(m.de('lead.findMany')[0].where).toMatchObject({ tenant_id: A, stage: 'PERDIDO', is_client: false });
  });

  it('SUPER_ADMIN sem conta: sem cláusula de conta (como antes)', async () => {
    const m = montar();
    await m.svc.findAll(undefined);
    expect(m.de('lead.findMany')[0].where).toEqual({ stage: { not: 'PERDIDO' } });
  });
});

describe('LeadsService por id — lead de outra conta ou sem conta é recusado', () => {
  it.each(['LB', 'L0'])('findOne(%s) com a conta A → 403', async (id) => {
    const m = montar();
    await expect(m.svc.findOne(id, A)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('findOne: própria conta devolve o lead; id inexistente devolve null; SUPER_ADMIN vê o lead sem conta', async () => {
    const m = montar();
    expect((await m.svc.findOne('LA', A))?.id).toBe('LA');
    expect(await m.svc.findOne('nao-existe', A)).toBeNull();
    expect((await m.svc.findOne('L0', undefined))?.id).toBe('L0');
  });

  it.each(['LB', 'L0'])('update(%s) com a conta A → 403 e nada gravado', async (id) => {
    const m = montar();
    await expect(m.svc.update(id, { name: 'X' }, A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.escritas()).toEqual([]);
  });

  it('update: própria conta, id inexistente e SUPER_ADMIN chamam lead.update como antes', async () => {
    const m = montar();
    await m.svc.update('LA', { name: 'Maria' }, A);
    await m.svc.update('nao-existe', { name: 'Y' }, A);
    await m.svc.update('L0', { name: 'Z' }, undefined);
    expect(m.de('lead.update')).toEqual([
      { where: { id: 'LA' }, data: { name: 'Maria' } },
      { where: { id: 'nao-existe' }, data: { name: 'Y' } },
      { where: { id: 'L0' }, data: { name: 'Z' } },
    ]);
    expect(m.de('lead.findUnique')).toEqual([
      { where: { id: 'LA' }, select: { tenant_id: true } },
      { where: { id: 'nao-existe' }, select: { tenant_id: true } },
    ]);
  });

  it.each(['LB', 'L0'])('getTimeline(%s) com a conta A → 403, sem ler histórico, notas nem memória', async (id) => {
    const m = montar();
    await expect(m.svc.getTimeline(id, A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.de('leadStageHistory.findMany')).toEqual([]);
    expect(m.de('leadNote.findMany')).toEqual([]);
    expect(m.de('aiMemory.findUnique')).toEqual([]);
  });

  it('getTimeline: própria conta e SUPER_ADMIN leem como antes', async () => {
    const m = montar();
    await m.svc.getTimeline('LA', A);
    await m.svc.getTimeline('L0', undefined);
    expect(m.de('leadStageHistory.findMany').map((a: any) => a.where)).toEqual([{ lead_id: 'LA' }, { lead_id: 'L0' }]);
  });

  it.each(['LB', 'L0'])('resetMemory(%s) com a conta A → 403 e memória intacta', async (id) => {
    const m = montar();
    await expect(m.svc.resetMemory(id, A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.escritas()).toEqual([]);
  });

  it('resetMemory: própria conta, id inexistente e SUPER_ADMIN apagam como antes', async () => {
    const m = montar();
    await m.svc.resetMemory('LA', A);
    await m.svc.resetMemory('nao-existe', A);
    await m.svc.resetMemory('L0', undefined);
    expect(m.de('aiMemory.deleteMany')).toEqual([
      { where: { lead_id: 'LA' } }, { where: { lead_id: 'nao-existe' } }, { where: { lead_id: 'L0' } },
    ]);
  });

  describe('summarizeLead', () => {
    const chave = process.env.OPENAI_API_KEY;
    beforeEach(() => { delete process.env.OPENAI_API_KEY; });
    afterAll(() => { if (chave !== undefined) process.env.OPENAI_API_KEY = chave; });

    it.each(['LB', 'L0'])('lead %s com a conta A → 403 antes de montar o resumo', async (id) => {
      const m = montar();
      await expect(m.svc.summarizeLead(id, A)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('própria conta e SUPER_ADMIN passam da checagem (para na falta da chave da IA, como antes)', async () => {
      const m = montar();
      await expect(m.svc.summarizeLead('LA', A)).rejects.toBeInstanceOf(BadRequestException);
      await expect(m.svc.summarizeLead('L0', undefined)).rejects.toBeInstanceOf(BadRequestException);
      await expect(m.svc.summarizeLead('nao-existe', A)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it.each(['LB', 'L0'])('promoteToPatientIfEligible(%s) com a conta A → ok:false, só a leitura do lead', async (id) => {
    const m = montar();
    expect(await m.svc.promoteToPatientIfEligible(id, A, 'teste')).toEqual({ ok: false });
    expect(m.ops.map(([n]) => n)).toEqual(['lead.findUnique']);
  });

  it('promoteToPatientIfEligible: própria conta segue (já paciente = idempotente); sem conta + lead sem conta segue', async () => {
    LEADS.LA.is_client = true;
    LEADS.L0.is_client = true;
    try {
      const m = montar();
      expect(await m.svc.promoteToPatientIfEligible('LA', A, 'teste')).toEqual({ ok: true, leadId: 'LA', alreadyClient: true });
      expect(await m.svc.promoteToPatientIfEligible('L0', undefined as any, 'teste')).toEqual({ ok: true, leadId: 'L0', alreadyClient: true });
      expect(await m.svc.promoteToPatientIfEligible('LA', undefined as any, 'teste')).toEqual({ ok: false });
    } finally {
      LEADS.LA.is_client = false;
      LEADS.L0.is_client = false;
    }
  });

  it.each(['LB', 'L0'])('demoteLeadById(%s) com a conta A → Acesso negado e nada gravado', async (id) => {
    const m = montar();
    expect(await m.svc.demoteLeadById(id, A)).toEqual({ ok: false, error: 'Acesso negado' });
    expect(m.escritas()).toEqual([]);
  });

  it('demoteLeadById: própria conta segue (já lead = idempotente)', async () => {
    const m = montar();
    expect(await m.svc.demoteLeadById('LA', A)).toEqual({ ok: true, leadId: 'LA', alreadyLead: true });
    expect(await m.svc.demoteLeadById('nao-existe', A)).toEqual({ ok: false, error: 'Contato não encontrado' });
  });
});

describe('PATCH /leads/:id/stage — lead e etapa da própria conta', () => {
  it.each(['LB', 'L0'])('lead %s com a conta A pela rota → 403 e nada gravado', async (id) => {
    const m = montar();
    await expect(m.ctl.updateStage(id, { stage: 'QUALIFICANDO' } as any, req(A))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.ctl.updateStage(id, { stage_id: 'stA' } as any, req(A))).rejects.toBeInstanceOf(ForbiddenException);
    await esperar();
    expect(m.escritas()).toEqual([]);
  });

  it('chamada interna (graduação/promoção) com lead sem conta: como antes', async () => {
    const m = montar();
    await m.svc.updateStatus('L0', 'QUALIFICANDO', A);
    expect(m.de('lead.update')).toHaveLength(1);
  });

  it('lead da própria conta, etapa do funil da conta: mesmo lead.update de antes, sem leitura a mais (fora a lista de laboratórios)', async () => {
    const m = montar();
    await m.ctl.updateStage('LA', { stage_id: 'stA' } as any, req(A));
    await esperar();
    expect(m.de('lead.update')).toEqual([
      { where: { id: 'LA' }, data: { stage: 'QUALIFICANDO', stage_entered_at: expect.any(Date), stage_id: 'stA', pipeline_id: 'pA' } },
    ]);
    // A conferência do funil da conta não lê nada a mais; a única leitura nova é a lista
    // de laboratórios (cache de 60 s) do freio de laboratório da troca de etapa (F5).
    expect(m.de('tenantBusinessProfile.findMany').length).toBeLessThanOrEqual(1);
    expect(m.de('leadStageHistory.create')).toEqual([
      { data: { lead_id: 'LA', from_stage: 'NOVO', to_stage: 'QUALIFICANDO', actor_id: 'u-1', loss_reason: null } },
    ]);
    // A leitura da etapa pede a conta do funil (é dela que sai a recusa abaixo).
    expect(m.de('pipelineStage.findUnique')[0]).toEqual({
      where: { id: 'stA' },
      select: expect.objectContaining({ pipeline_id: true, pipeline: { select: { tenant_id: true } } }),
    });
  });

  it('lead da própria conta, stage legado (sem stage_id): mesmas chamadas de antes', async () => {
    const m = montar();
    await m.ctl.updateStage('LA', { stage: 'QUALIFICANDO' } as any, req(A));
    await esperar();
    expect(m.de('lead.update')).toEqual([
      { where: { id: 'LA' }, data: { stage: 'QUALIFICANDO', stage_entered_at: expect.any(Date) } },
    ]);
    expect(m.de('pipelineStage.findUnique')).toEqual([]);
  });

  it('etapa de funil de OUTRA conta → a mesma 403 de etapa inexistente, nada gravado', async () => {
    const m = montar();
    const outra = await m.ctl.updateStage('LA', { stage_id: 'stB' } as any, req(A)).catch((e) => e);
    const inexistente = await m.ctl.updateStage('LA', { stage_id: 'nao-existe' } as any, req(A)).catch((e) => e);
    expect(outra).toBeInstanceOf(ForbiddenException);
    expect(outra.message).toBe('stage_id inválido');
    expect(inexistente.message).toBe(outra.message);
    await esperar();
    expect(m.escritas()).toEqual([]);
  });

  it('a recusa da etapa de outra conta depende do select pedir pipeline.tenant_id (o mock não entrega o que não foi pedido)', async () => {
    // Com o select de hoje: 403.
    const hoje = montar();
    await expect(hoje.ctl.updateStage('LA', { stage_id: 'stB' } as any, req(A))).rejects.toBeInstanceOf(ForbiddenException);

    // Mesma chamada, mas a leitura da etapa sem `pipeline` no select: a conta do funil
    // não chega, a clínica cai no caminho de funil sem conta e a recusa deixa de existir.
    // É isso que o teste anterior pega se o campo sair do select do service.
    const semCampo = montar();
    const original = semCampo.prisma.pipelineStage.findUnique.getMockImplementation()!;
    semCampo.prisma.pipelineStage.findUnique.mockImplementation((a: any) => {
      const { pipeline: _funil, ...resto } = a.select ?? {};
      return original({ ...a, select: resto });
    });
    await semCampo.ctl.updateStage('LA', { stage_id: 'stB' } as any, req(A));
    expect(semCampo.de('pipelineStage.findUnique')[0].select.pipeline).toBeUndefined();
    expect(semCampo.de('lead.update')[0].data).toMatchObject({ stage_id: 'stB', pipeline_id: 'pB' });
  });

  it('funil legado sem conta: clínica segue aceitando; laboratório recebe 403', async () => {
    const clinica = montar([LAB]);
    await clinica.ctl.updateStage('LA', { stage_id: 'st0' } as any, req(A));
    expect(clinica.de('lead.update')[0].data).toMatchObject({ stage_id: 'st0', pipeline_id: 'p0' });

    const lab = montar([LAB]);
    const e = await lab.ctl.updateStage('LLAB', { stage_id: 'st0' } as any, req(LAB)).catch((x) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.message).toBe('stage_id inválido');
    await esperar();
    expect(lab.escritas()).toEqual([]);
  });

  it('graduação interna para a etapa do funil da própria conta segue igual', async () => {
    const m = montar();
    await m.svc.updateStatus('LA', undefined, A, undefined, 'u-1', 'stA');
    expect(m.de('lead.update')[0].data).toMatchObject({ stage_id: 'stA', pipeline_id: 'pA' });
  });

  it('SUPER_ADMIN sem conta: qualquer lead e qualquer etapa, como antes', async () => {
    const m = montar([LAB]);
    await m.ctl.updateStage('L0', { stage_id: 'stB' } as any, req(undefined));
    await m.ctl.updateStage('LB', { stage_id: 'st0' } as any, req(undefined));
    expect(m.de('lead.update').map((a: any) => a.data.stage_id)).toEqual(['stB', 'st0']);
    expect(m.de('lead.findUnique').filter((a: any) => a.select?.tenant_id && Object.keys(a.select).length === 1)).toEqual([]);
  });
});

describe('Notas do lead — só lead da própria conta', () => {
  it.each(['LB', 'L0'])('listar e criar nota no lead %s com a conta A → 403, nada lido nem gravado', async (id) => {
    const m = montar();
    await expect(m.notasCtl.findAll(id, req(A))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.notasCtl.create(id, { text: 'oi' } as any, req(A))).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.de('leadNote.findMany')).toEqual([]);
    expect(m.escritas()).toEqual([]);
  });

  it('própria conta: mesmo findMany e mesmo create de antes', async () => {
    const m = montar();
    await m.notasCtl.findAll('LA', req(A));
    await m.notasCtl.create('LA', { text: 'oi' } as any, req(A));
    expect(m.de('leadNote.findMany')).toEqual([
      { where: { lead_id: 'LA' }, include: { user: { select: { id: true, name: true } } }, orderBy: { created_at: 'desc' } },
    ]);
    expect(m.de('leadNote.create')).toEqual([
      { data: { lead_id: 'LA', user_id: 'u-1', text: 'oi' }, include: { user: { select: { id: true, name: true } } } },
    ]);
  });

  it('SUPER_ADMIN sem conta: lista e cria sem leitura a mais (como antes)', async () => {
    const m = montar();
    await m.notasCtl.findAll('L0', req(undefined));
    await m.notasCtl.create('L0', { text: 'oi' } as any, req(undefined));
    expect(m.ops.map(([n]) => n)).toEqual(['leadNote.findMany', 'leadNote.create']);
  });

  it.each([
    ['nB', 'LB'],
    ['n0', 'L0'],
  ])('ADMIN da conta A apagando a nota %s (lead %s) → 404 e nada apagado', async (nota, lead) => {
    const m = montar();
    const admin = req(A, { roles: ['ADMIN'], role: 'ADMIN' });
    await expect(m.notasCtl.delete(lead, nota, admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.notasCtl.delete('LA', nota, admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.escritas()).toEqual([]);
  });

  it('nota de outro lead da URL → 404 (mesmo da própria conta)', async () => {
    const m = montar();
    await expect(m.notasCtl.delete('LB', 'nA', req(A, { id: 'autor-a' }))).rejects.toBeInstanceOf(NotFoundException);
    expect(m.escritas()).toEqual([]);
  });

  it('própria conta: autor apaga; ADMIN apaga (inclusive ADMIN fora da 1ª posição); outro usuário recebe 403', async () => {
    const m = montar();
    await expect(m.notasCtl.delete('LA', 'nA', req(A, { id: 'outro' }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.escritas()).toEqual([]);
    await m.notasCtl.delete('LA', 'nA', req(A, { id: 'autor-a' }));
    await m.notasCtl.delete('LA', 'nA', req(A, { id: 'outro', roles: ['OPERADOR', 'ADMIN'], role: 'OPERADOR' }));
    await m.notasCtl.delete('LA', 'nA', req(A, { id: 'outro', roles: undefined, role: 'ADMIN' }));
    expect(m.de('leadNote.delete')).toEqual([{ where: { id: 'nA' } }, { where: { id: 'nA' } }, { where: { id: 'nA' } }]);
  });

  it('nota inexistente: 404 como antes', async () => {
    const m = montar();
    await expect(m.notasCtl.delete('LA', 'nao-existe', req(A))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SUPER_ADMIN sem conta: autor apaga nota de lead sem conta, sem leitura a mais', async () => {
    const m = montar();
    await m.notasCtl.delete('L0', 'n0', req(undefined, { id: 'autor-0' }));
    expect(m.ops.map(([n]) => n)).toEqual(['leadNote.findUnique', 'leadNote.delete']);
  });
});
