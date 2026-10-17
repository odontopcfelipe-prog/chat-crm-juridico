import { ReturnAlertsService } from './return-alerts.service';

// Quadro de Retornos com banco FALSO: confere que a aba de limpeza junta todas as limpezas
// (outros procedimentos de limpeza, arquivados e consultas comparecidas na agenda) e que o
// resto do quadro não muda.
const T = '00000000-0000-0000-0000-000000000000';
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const pat = (id: string) => ({ id, name: `Paciente ${id}`, phone: null, avatar_url: null });

function fakePrisma() {
  const catalog = [
    { id: 'p1', name: 'Profilaxia (limpeza + raspagem)', category: 'PROFILAXIA', active: true, default_revisit_months: 6 },
    { id: 'p2', name: 'Limpeza', category: null, active: true, default_revisit_months: null },
    { id: 'p3', name: 'Limpeza antiga', category: null, active: false, default_revisit_months: 6 },
    { id: 'p4', name: 'Clareamento de Consultorio', category: 'ESTETICA_DENTAL', active: true, default_revisit_months: 12 },
    { id: 'p5', name: 'Limpeza de pele', category: 'LIMPEZA_PELE', active: true, default_revisit_months: 3 },
  ];
  const patients = ['A', 'B', 'C', 'D', 'E', 'G'].map((id) => ({ ...pat(id), lead_id: id === 'E' ? 'L1' : null }));
  const item = (pid: string, proc: (typeof catalog)[number], date: string, by: string | null) => ({
    executed_at: d(date),
    executed_by: by ? { name: by } : null,
    procedure: { id: proc.id, name: proc.name, default_revisit_months: proc.default_revisit_months },
    treatment_plan: { patient_id: pid, patient: pat(pid) },
  });
  return {
    procedure: { findMany: jest.fn(async () => catalog) },
    treatmentPlanItem: {
      findMany: jest.fn(async (args: any) =>
        args.where.procedure_id
          ? // bloco da limpeza: itens DONE de qualquer procedimento de limpeza
            [item('A', catalog[0], '2026-07-13', 'Dra. Suellen'), item('C', catalog[1], '2026-05-10', 'Dr. X'), item('D', catalog[2], '2025-03-01', 'Dr. X')]
          : // bloco geral (procedimento ativo): limpeza da aba + clareamento
            [item('A', catalog[0], '2026-07-13', 'Dra. Suellen'), item('B', catalog[3], '2026-08-01', 'Dra. Suellen')],
      ),
    },
    calendarEvent: {
      findMany: jest.fn(async () => [
        { start_at: d('2026-09-20'), title: 'Limpeza', patient_id: 'A', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Ana' }, treatment_plan_items: [] },
        { start_at: d('2026-06-01'), title: 'Consulta', patient_id: null, lead_id: 'L1', appointment_type: { name: 'Profilaxia' }, assigned_user: { name: 'Dra. Ana' }, treatment_plan_items: [] },
        { start_at: d('2026-06-02'), title: 'Limpeza de pele', patient_id: 'F', lead_id: null, appointment_type: null, assigned_user: null, treatment_plan_items: [] },
        { start_at: d('2026-04-15'), title: 'Retorno', patient_id: 'G', lead_id: null, appointment_type: null, assigned_user: null, treatment_plan_items: [{ id: 'tpi' }] },
      ]),
    },
    patient: {
      findMany: jest.fn(async (args: any) =>
        args.where.lead_id
          ? patients.filter((p) => p.lead_id && args.where.lead_id.in.includes(p.lead_id)).map((p) => ({ id: p.id, lead_id: p.lead_id }))
          : patients.filter((p) => args.where.id.in.includes(p.id)).map(({ lead_id, ...p }) => p),
      ),
    },
    maintenanceTask: { findMany: jest.fn(async () => []) },
    tenantSetting: { findUnique: jest.fn(async () => null) },
    globalSetting: { findUnique: jest.fn(async () => null) },
  };
}

describe('ReturnAlertsService.getMaintenanceBoard — aba de limpeza', () => {
  it('junta todas as limpezas numa aba só, com a próxima vinda da mais recente', async () => {
    const prisma = fakePrisma();
    const svc = new ReturnAlertsService(prisma as any);
    const board = await svc.getMaintenanceBoard(T);

    // Abas: limpeza "Limpeza"/arquivada NÃO viram aba própria; estética segue separada.
    expect(board.procedures).toEqual(['Clareamento de Consultorio', 'Limpeza de pele', 'Profilaxia (limpeza + raspagem)']);

    const limp = board.recalls.filter((r) => r.type === 'Profilaxia (limpeza + raspagem)');
    const by = Object.fromEntries(limp.map((r) => [r.patient.id, r]));
    expect(Object.keys(by).sort()).toEqual(['A', 'C', 'D', 'E', 'G']); // F (limpeza de pele) fora

    // A: plano em 13/07, mas veio na agenda em 20/09 → conta a mais recente.
    expect(by.A.source).toBe('agenda');
    expect(by.A.executed_by_name).toBe('Dra. Ana');
    expect(by.A.return_date.toISOString().slice(0, 10)).toBe('2027-03-20');
    // C: procedimento "Limpeza" (retorno desligado) entra com os 6 meses da aba.
    expect(by.C.return_date.toISOString().slice(0, 10)).toBe('2026-11-10');
    expect(by.C.months).toBe(6);
    // D: procedimento de limpeza arquivado.
    expect(by.D.return_date.toISOString().slice(0, 10)).toBe('2025-09-01');
    // E: consulta só com lead → achou o paciente pelo lead.
    expect(by.E.source).toBe('agenda');

    // 1 recall por paciente na aba de limpeza; nada com o nome das outras limpezas.
    expect(limp).toHaveLength(5);
    expect(board.recalls.some((r) => r.type === 'Limpeza' || r.type === 'Limpeza antiga')).toBe(false);
    // Resto do quadro igual: clareamento do B continua.
    expect(board.recalls.filter((r) => r.type === 'Clareamento de Consultorio').map((r) => r.patient.id)).toEqual(['B']);

    // A consulta à agenda é só do tenant, só clínica, só comparecido.
    const evWhere = (prisma.calendarEvent.findMany as jest.Mock).mock.calls[0][0].where;
    expect(evWhere.tenant_id).toBe(T);
    expect(evWhere.status.in).toEqual(['COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO']);
    expect(evWhere.type.in).not.toContain('TAREFA');
  });

  it('sem limpeza com retorno ligado: quadro igual ao de antes (opt-in)', async () => {
    const prisma = fakePrisma();
    const cat = await prisma.procedure.findMany();
    cat[0].default_revisit_months = null as any;
    prisma.procedure.findMany = jest.fn(async () => cat);
    const svc = new ReturnAlertsService(prisma as any);
    const board = await svc.getMaintenanceBoard(T);
    expect(board.procedures).toEqual(['Clareamento de Consultorio', 'Limpeza de pele']);
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(board.recalls.map((r) => r.type)).toEqual(['Clareamento de Consultorio']);
  });
});
