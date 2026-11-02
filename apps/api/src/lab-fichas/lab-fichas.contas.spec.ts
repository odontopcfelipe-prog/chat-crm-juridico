/**
 * F8 do laboratório — fichas: cada conta só lê e grava o que é DELA, e só conta de
 * laboratório entra.
 *
 * Prisma mockado (registros com a conta de cada um). Perguntas:
 *  (a) o SoLaboratorioGuard está na CLASSE (vale para todo handler, inclusive os
 *      futuros) e recusa clínica e usuário sem conta com 403 VERTICAL_DENIED;
 *  (b) laboratório A com id de B (cliente, serviço ou orçamento) → 404 e nada gravado;
 *  (c) A no próprio registro → gravado com o tenant_id de A;
 *  (d) GET sem linha → gravado:false, com o tipo tirado do documento;
 *  (e) carteira: orçamento de cliente fora da carteira do usuário restrito → 403.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { __limparCacheLabTenants } from '@crm/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/decorators/requires-permission.decorator';
import { SoLaboratorioGuard } from '../business-type/so-laboratorio.guard';
import { LabFichasController } from './lab-fichas.controller';
import { LabFichasService } from './lab-fichas.service';
import { LAB_FICHAS_API } from './lab-fichas-textos';

const A = 'lab-a';
const B = 'lab-b';
const CLINICA = 'clinica-c';

type Reg = Record<string, any>;

/** Banco simulado: igualdade simples no where + as formas que o serviço usa. */
function montar() {
  const quando = new Date('2026-11-01T12:00:00.000Z');
  const db: Record<string, Reg[]> = {
    tenantBusinessProfile: [
      { tenant_id: A, business_type: 'LABORATORIO' },
      { tenant_id: B, business_type: 'LABORATORIO' },
    ],
    user: [
      { id: 'adm-a', sector: 'admin', extra_grants: [], extra_revokes: [] },
      { id: 'restrito-a', sector: 'dentista', extra_grants: [], extra_revokes: [] },
    ],
    patient: [
      { id: 'cli-a-cpf', tenant_id: A, cpf: '111.111.111-11' },
      { id: 'cli-a-cnpj', tenant_id: A, cpf: '11.111.111/1111-11' },
      { id: 'cli-a-sem-doc', tenant_id: A, cpf: null },
      { id: 'cli-a-linha-b', tenant_id: A, cpf: null },
      { id: 'cli-b', tenant_id: B, cpf: '111.111.111-11' },
    ],
    procedure: [
      { id: 'serv-a', tenant_id: A },
      { id: 'serv-b', tenant_id: B },
    ],
    quote: [
      { id: 'orc-a', patient_id: 'cli-a-cpf', deleted_at: null, accepted_from_id: null, renegotiated_from_id: null, created_at: quando },
      { id: 'orc-a-cnpj', patient_id: 'cli-a-cnpj', deleted_at: null, accepted_from_id: null, renegotiated_from_id: null, created_at: quando },
      { id: 'orc-a-apagado', patient_id: 'cli-a-cpf', deleted_at: quando, accepted_from_id: null, renegotiated_from_id: null, created_at: quando },
      { id: 'orc-b', patient_id: 'cli-b', deleted_at: null, accepted_from_id: null, renegotiated_from_id: null, created_at: quando },
    ],
    // Linha com conta trocada (não acontece; defesa dupla): nunca aparece nem é regravada.
    patientLabProfile: [{ patient_id: 'cli-a-linha-b', tenant_id: B, kind: 'CLINICA', requesting_dentists: [], updated_at: quando }],
    procedureLabSpec: [{ procedure_id: 'serv-b', tenant_id: B, lead_time_days: 5, unit: 'ELEMENTO', needs_shade: false, has_tryin: false, updated_at: quando }],
    quoteLabCase: [{ quote_id: 'orc-b', tenant_id: B, shade: 'A2', updated_at: quando }],
  };
  /** Carteira do usuário restrito (o que ownPatientsWhere acharia). */
  const CARTEIRA: Record<string, string[]> = { 'restrito-a': ['cli-a-cpf'] };

  const casa = (tabela: string, r: Reg, where: Reg = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v === undefined) return true;
      if (k === 'OR') return (CARTEIRA[(v as Reg[])[0]?.primary_dentist_id] ?? []).includes(r.id);
      if (k === 'patient' && tabela === 'quote') return db.patient.find((p) => p.id === r.patient_id)?.tenant_id === v.tenant_id;
      if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(r[k]);
      return r[k] === v;
    });

  const prisma: any = {};
  for (const tabela of Object.keys(db)) {
    prisma[tabela] = {
      findFirst: jest.fn(async (a: Reg = {}) => db[tabela].find((r) => casa(tabela, r, a.where)) ?? null),
      findUnique: jest.fn(async (a: Reg = {}) => db[tabela].find((r) => casa(tabela, r, a.where)) ?? null),
      findMany: jest.fn(async (a: Reg = {}) => db[tabela].filter((r) => casa(tabela, r, a.where))),
      upsert: jest.fn(async (a: Reg) => {
        const atual = db[tabela].find((r) => casa(tabela, r, a.where));
        if (atual) return Object.assign(atual, a.update, { updated_at: quando });
        const novo = { ...a.create, created_at: quando, updated_at: quando };
        db[tabela].push(novo);
        return novo;
      }),
      update: jest.fn(async (a: Reg) => Object.assign(db[tabela].find((r) => casa(tabela, r, a.where))!, a.data)),
    };
  }
  const service = new LabFichasService(prisma);
  const controller = new LabFichasController(service);
  const gravacoes = () =>
    ['patientLabProfile', 'procedureLabSpec', 'quoteLabCase'].reduce(
      (n, t) => n + prisma[t].upsert.mock.calls.length + prisma[t].update.mock.calls.length,
      0,
    );
  return { db, prisma, controller, gravacoes };
}

const req = (user: Reg) => ({ user });
const ADM_A = { id: 'adm-a', roles: ['ADMIN'], tenant_id: A };
const RESTRITO_A = { id: 'restrito-a', roles: ['DENTIST'], tenant_id: A };

const contexto = (user: Reg | undefined) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;

async function recusa(p: Promise<unknown>): Promise<{ tipo: string; status: number; corpo: unknown }> {
  try {
    await p;
  } catch (e: any) {
    return { tipo: e?.constructor?.name, status: e?.getStatus?.(), corpo: e?.getResponse?.() };
  }
  throw new Error('esperava recusa');
}

beforeEach(() => {
  __limparCacheLabTenants();
  PermissionsGuard.invalidate('adm-a');
  PermissionsGuard.invalidate('restrito-a');
});

describe('LabFichasController — só laboratório', () => {
  it('o SoLaboratorioGuard (e o JwtAuthGuard) estão na classe', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, LabFichasController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, SoLaboratorioGuard]));
    // Nenhum handler troca os guards da classe por outros.
    for (const nome of Object.getOwnPropertyNames(LabFichasController.prototype).filter((n) => n !== 'constructor')) {
      expect([nome, Reflect.getMetadata(GUARDS_METADATA, (LabFichasController.prototype as any)[nome]) ?? null]).toEqual([nome, null]);
    }
  });

  it('o guard recusa clínica e usuário sem conta com 403 VERTICAL_DENIED', async () => {
    const { prisma } = montar();
    const guard = new SoLaboratorioGuard(prisma);
    for (const user of [{ id: 'u', roles: ['ADMIN'], tenant_id: CLINICA }, { id: 'dono', roles: ['SUPER_ADMIN'] }, undefined]) {
      const r = await recusa(guard.canActivate(contexto(user)));
      expect(r).toEqual({
        tipo: 'ForbiddenException',
        status: 403,
        corpo: { message: 'Função disponível só para laboratório.', code: 'VERTICAL_DENIED' },
      });
    }
  });

  it('o guard deixa passar o token de laboratório (bt) e a conta da lista de laboratórios', async () => {
    const { prisma } = montar();
    const guard = new SoLaboratorioGuard(prisma);
    await expect(guard.canActivate(contexto({ id: 'u', tenant_id: 'lab-recem-criado', bt: 'LABORATORIO' }))).resolves.toBe(true);
    await expect(guard.canActivate(contexto({ id: 'u', tenant_id: A }))).resolves.toBe(true);
    await expect(guard.canActivate(contexto({ id: 'u', tenant_id: B, bt: undefined }))).resolves.toBe(true);
  });
});

describe('LabFichasController — cada laboratório só o que é dele', () => {
  const DE_B: Array<[string, (c: LabFichasController) => Promise<unknown>, string]> = [
    ['getPatientProfile', (c) => c.getPatientProfile('cli-b', req(ADM_A)), LAB_FICHAS_API.clienteNaoEncontrado],
    ['putPatientProfile', (c) => c.putPatientProfile('cli-b', { kind: 'CLINICA' }, req(ADM_A)), LAB_FICHAS_API.clienteNaoEncontrado],
    ['listPatientCases', (c) => c.listPatientCases('cli-b', req(ADM_A)), LAB_FICHAS_API.clienteNaoEncontrado],
    ['getProcedureSpec', (c) => c.getProcedureSpec('serv-b', req(ADM_A)), LAB_FICHAS_API.servicoNaoEncontrado],
    ['putProcedureSpec', (c) => c.putProcedureSpec('serv-b', { lead_time_days: 3, unit: 'ARCADA' }, req(ADM_A)), LAB_FICHAS_API.servicoNaoEncontrado],
    ['getQuoteCase', (c) => c.getQuoteCase('orc-b', req(ADM_A)), LAB_FICHAS_API.orcamentoNaoEncontrado],
    ['putQuoteCase', (c) => c.putQuoteCase('orc-b', { shade: 'B1' }, req(ADM_A)), LAB_FICHAS_API.orcamentoNaoEncontrado],
    ['getQuoteCase (apagado)', (c) => c.getQuoteCase('orc-a-apagado', req(ADM_A)), LAB_FICHAS_API.orcamentoNaoEncontrado],
    ['putQuoteCase (apagado)', (c) => c.putQuoteCase('orc-a-apagado', { shade: 'B1' }, req(ADM_A)), LAB_FICHAS_API.orcamentoNaoEncontrado],
  ];

  it.each(DE_B)('%s com id de outra conta → 404 e nada gravado', async (_nome, chamar, texto) => {
    const m = montar();
    const r = await recusa(chamar(m.controller));
    expect(r.tipo).toBe(NotFoundException.name);
    expect(r.status).toBe(404);
    expect((r.corpo as any).message).toBe(texto);
    expect(m.gravacoes()).toBe(0);
    // Nada da outra conta foi alterado.
    expect(m.db.quoteLabCase.find((c) => c.quote_id === 'orc-b')).toMatchObject({ tenant_id: B, shade: 'A2' });
  });

  it('linha de outra conta na tabela nova não aparece no GET e não é regravada no PUT', async () => {
    const m = montar();
    await expect(m.controller.getPatientProfile('cli-a-linha-b', req(ADM_A))).resolves.toMatchObject({ gravado: false });
    expect(m.prisma.patientLabProfile.findFirst).toHaveBeenCalledWith({ where: { patient_id: 'cli-a-linha-b', tenant_id: A } });
    const r = await recusa(m.controller.putPatientProfile('cli-a-linha-b', { kind: 'CLINICA' }, req(ADM_A)));
    expect(r.status).toBe(404);
    expect(m.gravacoes()).toBe(0);
  });

  it('A no próprio cliente → upsert com o tenant_id de A só na criação', async () => {
    const m = montar();
    const r = await m.controller.putPatientProfile('cli-a-cnpj', { kind: 'CLINICA', legal_name: '  Razão Teste  ' }, req(ADM_A));
    expect(m.prisma.patientLabProfile.upsert).toHaveBeenCalledTimes(1);
    const args = m.prisma.patientLabProfile.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ patient_id: 'cli-a-cnpj' });
    expect(args.create).toMatchObject({ patient_id: 'cli-a-cnpj', tenant_id: A, kind: 'CLINICA', legal_name: 'Razão Teste' });
    expect(args.update).not.toHaveProperty('tenant_id');
    expect(r).toMatchObject({ patient_id: 'cli-a-cnpj', gravado: true, kind: 'CLINICA', legal_name: 'Razão Teste', updated_at: '2026-11-01T12:00:00.000Z' });
  });

  it('A no próprio serviço e no próprio orçamento → upsert com o tenant_id de A', async () => {
    const m = montar();
    await m.controller.putProcedureSpec('serv-a', { lead_time_days: 7, unit: 'ELEMENTO' }, req(ADM_A));
    expect(m.prisma.procedureLabSpec.upsert.mock.calls[0][0]).toMatchObject({
      where: { procedure_id: 'serv-a' },
      create: { procedure_id: 'serv-a', tenant_id: A, lead_time_days: 7, unit: 'ELEMENTO' },
    });
    await m.controller.putQuoteCase('orc-a', { shade: 'A3' }, req(ADM_A));
    expect(m.prisma.quoteLabCase.upsert.mock.calls[0][0]).toMatchObject({
      where: { quote_id: 'orc-a' },
      create: { quote_id: 'orc-a', tenant_id: A, shade: 'A3' },
    });
    expect(m.prisma.quoteLabCase.upsert.mock.calls[0][0].update).not.toHaveProperty('tenant_id');
    await expect(m.controller.listProcedureSpecs(req(ADM_A))).resolves.toEqual({
      fichas: { 'serv-a': { lead_time_days: 7, warranty_days: null, unit: 'ELEMENTO', default_material: null, needs_shade: false, has_tryin: false } },
    });
    expect(m.prisma.procedureLabSpec.findMany).toHaveBeenCalledWith({ where: { tenant_id: A } });
  });

  it('GET sem linha → gravado:false e o tipo do documento (CPF → dentista, CNPJ → clínica, vazio → dentista)', async () => {
    const m = montar();
    const vazio = {
      cro_number: null,
      cro_uf: null,
      legal_name: null,
      clinic_name: null,
      contact_name: null,
      contact_phone: null,
      requesting_dentists: [],
      delivery_notes: null,
      gravado: false,
      updated_at: null,
    };
    await expect(m.controller.getPatientProfile('cli-a-cpf', req(ADM_A))).resolves.toEqual({ patient_id: 'cli-a-cpf', kind: 'DENTISTA', ...vazio });
    await expect(m.controller.getPatientProfile('cli-a-cnpj', req(ADM_A))).resolves.toEqual({ patient_id: 'cli-a-cnpj', kind: 'CLINICA', ...vazio });
    await expect(m.controller.getPatientProfile('cli-a-sem-doc', req(ADM_A))).resolves.toEqual({ patient_id: 'cli-a-sem-doc', kind: 'DENTISTA', ...vazio });
    await expect(m.controller.getProcedureSpec('serv-a', req(ADM_A))).resolves.toEqual({ procedure_id: 'serv-a', ficha: null });
    await expect(m.controller.getQuoteCase('orc-a', req(ADM_A))).resolves.toEqual({
      quote_id: 'orc-a',
      gravado: false,
      herdado_de: null,
      updated_at: null,
      patient_ref: null,
      requested_by_name: null,
      shade: null,
      material: null,
      due_date: null,
      instructions: null,
      external_files_url: null,
      received_at: null,
    });
    expect(m.gravacoes()).toBe(0);
  });

  it('PUT simultâneo (P2002 no upsert) é refeito uma vez como update, sem trocar a conta', async () => {
    const m = montar();
    m.db.quoteLabCase.push({ quote_id: 'orc-a', tenant_id: A, shade: 'A1', updated_at: new Date('2026-11-01T12:00:00.000Z') });
    m.prisma.quoteLabCase.upsert.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(m.controller.putQuoteCase('orc-a', { shade: 'D2' }, req(ADM_A))).resolves.toMatchObject({ gravado: true, shade: 'D2' });
    expect(m.prisma.quoteLabCase.update).toHaveBeenCalledTimes(1);
    const args = m.prisma.quoteLabCase.update.mock.calls[0][0];
    expect(args.where).toEqual({ quote_id: 'orc-a' });
    expect(args.data).not.toHaveProperty('tenant_id');
  });
});

describe('LabFichasController — carteira do usuário restrito', () => {
  it('orçamento de cliente fora da carteira → 403 PERMISSION_DENIED e nada gravado', async () => {
    const m = montar();
    for (const chamar of [
      () => m.controller.getQuoteCase('orc-a-cnpj', req(RESTRITO_A)),
      () => m.controller.putQuoteCase('orc-a-cnpj', { shade: 'A1' }, req(RESTRITO_A)),
    ]) {
      const r = await recusa(chamar());
      expect(r).toEqual({
        tipo: ForbiddenException.name,
        status: 403,
        corpo: { message: LAB_FICHAS_API.foraDaCarteira, code: 'PERMISSION_DENIED' },
      });
    }
    expect(m.gravacoes()).toBe(0);
  });

  it('orçamento de cliente da carteira → passa', async () => {
    const m = montar();
    await expect(m.controller.getQuoteCase('orc-a', req(RESTRITO_A))).resolves.toMatchObject({ quote_id: 'orc-a', gravado: false });
    await expect(m.controller.putQuoteCase('orc-a', { material: 'Zircônia' }, req(RESTRITO_A))).resolves.toMatchObject({
      quote_id: 'orc-a',
      gravado: true,
      material: 'Zircônia',
    });
  });
});
