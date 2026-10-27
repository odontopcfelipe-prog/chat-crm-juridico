/**
 * Cadastros: ids que vêm do corpo ou da rota (contato do paciente, dentista
 * responsável, dentista da ortodontia, indicador, destino da transferência ao
 * excluir usuário, dentista da especialidade, grupo do procedimento) só da
 * própria conta. De outra conta ou sem conta → recusado e nada é gravado.
 * Na própria conta as gravações são as mesmas de antes.
 */
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { UsersService } from '../users/users.service';
import { SpecialtiesService } from '../specialties/specialties.service';
import { ProceduresService } from '../procedures/procedures.service';
import { ProceduresController } from '../procedures/procedures.controller';
import { SpecialtiesController } from '../specialties/specialties.controller';
import { PatientsController } from './patients.controller';

const A = 'conta-a';
const B = 'conta-b';

const LEADS: Record<string, string | null> = { 'lead-a': A, 'lead-b': B, 'lead-nulo': null };
const USERS: Record<string, string | null> = { 'u-a': A, 'u-a2': A, 'u-b': B, 'u-nulo': null };
const SPECIALTIES: Record<string, { tenant_id: string; active: boolean }> = {
  'esp-a': { tenant_id: A, active: true },
  'esp-a-inativa': { tenant_id: A, active: false },
  'esp-b': { tenant_id: B, active: true },
};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ───────────────────────────── Pacientes ─────────────────────────────

function montarPacientes() {
  const escritas: any[] = [];
  const patients: Record<string, any> = {
    'pac-a': { id: 'pac-a', tenant_id: A, lead_id: null, primary_dentist_id: 'u-b', ortho_dentist_id: null, referred_by_id: 'pac-b' },
    'pac-a2': { id: 'pac-a2', tenant_id: A, lead_id: null, primary_dentist_id: null, ortho_dentist_id: null, referred_by_id: null },
    'pac-b': { id: 'pac-b', tenant_id: B, lead_id: null, primary_dentist_id: null, ortho_dentist_id: null, referred_by_id: null },
  };
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ plan: null })) },
    lead: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id in LEADS
          ? { id: where.id, tenant_id: LEADS[where.id], name: 'Contato', phone: null, email: null, origin: null, profile_picture_url: null }
          : null,
      ),
      update: jest.fn(async (args: any) => { escritas.push(['lead.update', args]); return {}; }),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        where.id.in.filter((id: string) => id in USERS).map((id: string) => ({ tenant_id: USERS[id] })),
      ),
    },
    patient: {
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async ({ where }: any) => (where.id ? patients[where.id] ?? null : null)),
      create: jest.fn(async (args: any) => {
        escritas.push(['patient.create', args]);
        return { id: 'novo', ...args.data };
      }),
      update: jest.fn(async (args: any) => {
        escritas.push(['patient.update', args]);
        return { ...patients[args.where.id], ...args.data };
      }),
    },
    patientTag: { findMany: jest.fn(async () => []) },
    calendarEvent: {
      updateMany: jest.fn(async (args: any) => { escritas.push(['calendarEvent.updateMany', args]); return { count: 0 }; }),
      findMany: jest.fn(async () => []),
    },
  };
  const referrals: any = { createPending: jest.fn(async () => null) };
  const svc = new PatientsService(prisma, {} as any, referrals, {} as any, {} as any, {} as any);
  return { svc, prisma, escritas };
}

describe('Pacientes — contato e dentistas só da própria conta', () => {
  it('cadastrar com contato de outra conta → 400, nada gravado', async () => {
    const { svc, escritas } = montarPacientes();
    await expect(svc.create(A, { name: 'X', lead_id: 'lead-b' })).rejects.toBeInstanceOf(BadRequestException);
    expect(escritas).toEqual([]);
  });

  it('cadastrar com contato sem conta → 400, nada gravado', async () => {
    const { svc, escritas } = montarPacientes();
    await expect(svc.create(A, { name: 'X', lead_id: 'lead-nulo' })).rejects.toBeInstanceOf(BadRequestException);
    expect(escritas).toEqual([]);
  });

  it('cadastrar com dentista responsável de outra conta ou sem conta → 400, nada gravado', async () => {
    const { svc, escritas } = montarPacientes();
    await expect(svc.create(A, { name: 'X', primary_dentist_id: 'u-b' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(A, { name: 'X', primary_dentist_id: 'u-nulo' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(A, { name: 'X', ortho_dentist_id: 'u-b' })).rejects.toBeInstanceOf(BadRequestException);
    expect(escritas).toEqual([]);
  });

  it('cadastrar com contato e dentista da própria conta → grava o mesmo de antes', async () => {
    const { svc, escritas } = montarPacientes();
    await svc.create(A, { name: 'X', lead_id: 'lead-a', primary_dentist_id: 'u-a' });
    expect(escritas).toEqual([
      ['patient.create', { data: { name: 'X', lead_id: 'lead-a', primary_dentist_id: 'u-a', tenant_id: A } }],
    ]);
  });

  it('cadastrar sem contato nem dentista → nenhuma consulta a mais', async () => {
    const { svc, prisma, escritas } = montarPacientes();
    await svc.create(A, { name: 'X' });
    expect(prisma.lead.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(escritas).toEqual([['patient.create', { data: { name: 'X', tenant_id: A } }]]);
  });

  it('contato que não existe segue como antes (vai para o banco)', async () => {
    const { svc, escritas } = montarPacientes();
    await svc.create(A, { name: 'X', lead_id: 'lead-nao-existe' });
    expect(escritas).toEqual([['patient.create', { data: { name: 'X', lead_id: 'lead-nao-existe', tenant_id: A } }]]);
  });

  it('editar pondo dentista ou indicador de outra conta → 400, nada gravado', async () => {
    const { svc, escritas } = montarPacientes();
    await expect(svc.update('pac-a2', A, { primary_dentist_id: 'u-b' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('pac-a2', A, { ortho_dentist_id: 'u-nulo' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('pac-a2', A, { referred_by_id: 'pac-b' })).rejects.toBeInstanceOf(BadRequestException);
    expect(escritas).toEqual([]);
  });

  it('editar com dentistas e indicador da própria conta → grava o mesmo de antes', async () => {
    const { svc, escritas } = montarPacientes();
    const data = { primary_dentist_id: 'u-a', ortho_dentist_id: 'u-a2', referred_by_id: 'pac-a', notes: 'ok' };
    await svc.update('pac-a2', A, data);
    expect(escritas).toEqual([['patient.update', { where: { id: 'pac-a2' }, data }]]);
  });

  it('editar reenviando o valor já gravado → aceito como antes', async () => {
    const { svc, escritas } = montarPacientes();
    const data = { primary_dentist_id: 'u-b', referred_by_id: 'pac-b', notes: 'ok' };
    await svc.update('pac-a', A, data);
    expect(escritas).toEqual([['patient.update', { where: { id: 'pac-a' }, data }]]);
  });

  it('editar tirando o dentista (null) → nenhuma consulta a mais', async () => {
    const { svc, prisma, escritas } = montarPacientes();
    await svc.update('pac-a2', A, { primary_dentist_id: null });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(escritas).toEqual([['patient.update', { where: { id: 'pac-a2' }, data: { primary_dentist_id: null } }]]);
  });

  it('editar paciente de outra conta → 403 como antes, nada gravado', async () => {
    const { svc, escritas } = montarPacientes();
    await expect(svc.update('pac-b', A, { notes: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(escritas).toEqual([]);
  });

  it('converter contato: conta e contato do corpo não valem; dentista de outra conta → 400', async () => {
    const { svc, escritas } = montarPacientes();
    await expect(
      svc.convertFromLead('lead-a', A, { primary_dentist_id: 'u-b' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(escritas).toEqual([]);

    await svc.convertFromLead('lead-a', A, { tenant_id: B, lead_id: 'lead-b', notes: 'n' } as any);
    const create = escritas.find((e) => e[0] === 'patient.create')[1];
    expect(create.data.tenant_id).toBe(A);
    expect(create.data.lead_id).toBe('lead-a');
  });

  it('converter contato sem dados extras → grava o mesmo de antes', async () => {
    const { svc, prisma, escritas } = montarPacientes();
    await svc.convertFromLead('lead-a', A);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(escritas[0]).toEqual([
      'patient.create',
      { data: { tenant_id: A, lead_id: 'lead-a', name: 'Contato', phone: null, email: null, referred_by: null } },
    ]);
  });

  it('sem conta no login → 400 "tenant_id ausente" como antes', () => {
    const svc: any = { create: jest.fn(), update: jest.fn() };
    const ctrl = new PatientsController(svc, {} as any, {} as any, {} as any);
    expect(() => ctrl.create({ name: 'X' } as any, { user: { id: 'super' } })).toThrow(BadRequestException);
    expect(svc.create).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── Usuários ─────────────────────────────

function montarUsuarios() {
  const escritas: any[] = [];
  const grava = (nome: string) => jest.fn((args: any) => { escritas.push([nome, args]); return Promise.resolve({ count: 0 }); });
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id in USERS ? { id: where.id, tenant_id: USERS[where.id] } : null)),
      findFirst: jest.fn(async ({ where }: any) =>
        where.id in USERS && (!('tenant_id' in where) || USERS[where.id] === where.tenant_id) ? { id: where.id } : null,
      ),
      delete: jest.fn(async (args: any) => { escritas.push(['user.delete', args]); return {}; }),
    },
    conversation: { updateMany: grava('conversation.updateMany') },
    calendarEvent: { updateMany: grava('calendarEvent.updateMany'), count: jest.fn(async () => 0) },
    lead: { updateMany: grava('lead.updateMany') },
    $transaction: jest.fn(async (ops: any[]) => { escritas.push(['$transaction', ops.length]); return Promise.all(ops); }),
  };
  const svc = new UsersService(prisma, {} as any, {} as any);
  return { svc, prisma, escritas };
}

const TRANSFERE = (de: string, para: string) => [
  ['conversation.updateMany', { where: { assigned_user_id: de }, data: { assigned_user_id: para } }],
  ['conversation.updateMany', { where: { assigned_dentist_id: de }, data: { assigned_dentist_id: para } }],
  ['calendarEvent.updateMany', { where: { assigned_user_id: de }, data: { assigned_user_id: para } }],
  ['calendarEvent.updateMany', { where: { created_by_id: de }, data: { created_by_id: para } }],
  ['lead.updateMany', { where: { cs_user_id: de }, data: { cs_user_id: para } }],
  ['$transaction', 5],
  ['user.delete', { where: { id: de } }],
];

describe('Usuários — excluir transferindo só para alguém da própria conta', () => {
  it('destino de outra conta ou sem conta → 400, nada gravado', async () => {
    const { svc, prisma, escritas } = montarUsuarios();
    await expect(svc.remove('u-a', A, 'u-b')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.remove('u-a', A, 'u-nulo')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
  });

  it('destino igual ao usuário removido → 400, nada gravado', async () => {
    const { svc, escritas } = montarUsuarios();
    await expect(svc.remove('u-a', A, 'u-a')).rejects.toBeInstanceOf(BadRequestException);
    expect(escritas).toEqual([]);
  });

  it('destino da própria conta → mesmas transferências e exclusão de antes', async () => {
    const { svc, escritas } = montarUsuarios();
    await svc.remove('u-a', A, 'u-a2');
    expect(escritas).toEqual(TRANSFERE('u-a', 'u-a2'));
  });

  it('destino que não existe → 400 como antes', async () => {
    const { svc, escritas } = montarUsuarios();
    await expect(svc.remove('u-a', A, 'u-nao-existe')).rejects.toThrow('Usuário destino da transferência não encontrado.');
    expect(escritas).toEqual([]);
  });

  it('sem destino → mesmo caminho de antes', async () => {
    const { svc, escritas } = montarUsuarios();
    await svc.remove('u-a', A);
    expect(escritas).toEqual([
      ['conversation.updateMany', { where: { assigned_user_id: 'u-a' }, data: { assigned_user_id: null } }],
      ['user.delete', { where: { id: 'u-a' } }],
    ]);
  });

  it('sem conta no login (SUPER_ADMIN) → transfere para qualquer conta, como antes', async () => {
    const { svc, prisma, escritas } = montarUsuarios();
    await svc.remove('u-b', undefined, 'u-a');
    expect(prisma.user.findFirst).toHaveBeenCalledWith({ where: { id: 'u-a' }, select: { id: true } });
    expect(escritas).toEqual(TRANSFERE('u-b', 'u-a'));
  });
});

// ─────────────────────────── Especialidades ───────────────────────────

function montarEspecialidades() {
  const escritas: any[] = [];
  const prisma: any = {
    specialty: {
      findUnique: jest.fn(async ({ where }: any) => SPECIALTIES[where.id] ?? null),
      update: jest.fn(async (args: any) => { escritas.push(['specialty.update', args]); return {}; }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id in USERS ? { tenant_id: USERS[where.id] } : null)),
    },
  };
  return { svc: new SpecialtiesService(prisma), prisma, escritas };
}

describe('Especialidades — dentista só da própria conta', () => {
  it('ligar dentista de outra conta ou sem conta → 403, nada gravado', async () => {
    const { svc, escritas } = montarEspecialidades();
    await expect(svc.addDentist('esp-a', 'u-b', A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.addDentist('esp-a', 'u-nulo', A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(escritas).toEqual([]);
  });

  it('ligar dentista da própria conta → mesma gravação de antes', async () => {
    const { svc, escritas } = montarEspecialidades();
    await svc.addDentist('esp-a', 'u-a', A);
    expect(escritas).toEqual([
      ['specialty.update', { where: { id: 'esp-a' }, data: { dentists: { connect: { id: 'u-a' } } } }],
    ]);
  });

  it('especialidade de outra conta → 403 como antes', async () => {
    const { svc, prisma, escritas } = montarEspecialidades();
    await expect(svc.addDentist('esp-b', 'u-a', A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
  });

  it('sem conta no login → 400 "tenant_id ausente" como antes', () => {
    const svc: any = { addDentist: jest.fn() };
    const ctrl = new SpecialtiesController(svc);
    expect(() => ctrl.addDentist('esp-a', 'u-a', { user: { id: 'super' } })).toThrow(BadRequestException);
    expect(svc.addDentist).not.toHaveBeenCalled();
  });
});

// ──────────────────────────── Procedimentos ────────────────────────────

function montarProcedimentos() {
  const escritas: any[] = [];
  const prisma: any = {
    specialty: { findUnique: jest.fn(async ({ where }: any) => SPECIALTIES[where.id] ?? null) },
    procedure: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === 'proc-a' ? { tenant_id: A } : where.id === 'proc-b' ? { tenant_id: B } : null)),
      create: jest.fn(async (args: any) => { escritas.push(['procedure.create', args]); return {}; }),
      update: jest.fn(async (args: any) => { escritas.push(['procedure.update', args]); return {}; }),
    },
  };
  return { svc: new ProceduresService(prisma), prisma, escritas };
}

describe('Procedimentos — grupo só da própria conta', () => {
  it('criar ou editar com grupo de outra conta → 403, nada gravado', async () => {
    const { svc, escritas } = montarProcedimentos();
    await expect(svc.create(A, { name: 'P', specialty_id: 'esp-b' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update('proc-a', A, { specialty_id: 'esp-b' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(escritas).toEqual([]);
  });

  it('grupo da própria conta, mesmo desativado → mesma gravação de antes', async () => {
    const { svc, prisma, escritas } = montarProcedimentos();
    await svc.create(A, { name: 'P', specialty_id: 'esp-a' });
    await svc.update('proc-a', A, { name: 'P2', specialty_id: 'esp-a-inativa' });
    expect(prisma.specialty.findUnique).toHaveBeenCalledWith({ where: { id: 'esp-a-inativa' }, select: { tenant_id: true } });
    expect(escritas).toEqual([
      ['procedure.create', { data: { name: 'P', specialty_id: 'esp-a', tenant_id: A } }],
      ['procedure.update', { where: { id: 'proc-a' }, data: { name: 'P2', specialty_id: 'esp-a-inativa' } }],
    ]);
  });

  it('sem grupo (null, vazio ou ausente) → nenhuma consulta a mais', async () => {
    const { svc, prisma, escritas } = montarProcedimentos();
    await svc.create(A, { name: 'P' });
    await svc.create(A, { name: 'P', specialty_id: null });
    await svc.update('proc-a', A, { specialty_id: '' as any });
    expect(prisma.specialty.findUnique).not.toHaveBeenCalled();
    expect(escritas).toHaveLength(3);
  });

  it('procedimento de outra conta → 403 como antes', async () => {
    const { svc, escritas } = montarProcedimentos();
    await expect(svc.update('proc-b', A, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(escritas).toEqual([]);
  });

  it('sem conta no login → 400 "tenant_id ausente" como antes', () => {
    const svc: any = { create: jest.fn() };
    const ctrl = new ProceduresController(svc);
    expect(() => ctrl.create({ name: 'P' } as any, { user: { id: 'super' } })).toThrow(BadRequestException);
    expect(svc.create).not.toHaveBeenCalled();
  });
});
