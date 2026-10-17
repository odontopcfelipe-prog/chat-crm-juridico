import { ReturnAlertsService } from './return-alerts.service';

// Quadro de Retornos com banco FALSO: confere que cada FAMÍLIA (limpeza, clareamento) junta
// todos os procedimentos dela (outros nomes, arquivados) + consultas comparecidas na agenda
// numa aba só, e que o resto do quadro não muda.
const T = '00000000-0000-0000-0000-000000000000';
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const pat = (id: string) => ({ id, name: `Paciente ${id}`, phone: null, avatar_url: null });

type Proc = { id: string; name: string; category: string | null; active: boolean; default_revisit_months: number | null };
type Ev = { start_at: Date; title: string; patient_id: string | null; lead_id: string | null; appointment_type: { name: string } | null; assigned_user: { name: string } | null; tpi_proc?: string };

function fakePrisma(catalog: Proc[]) {
  const P = Object.fromEntries(catalog.map((p) => [p.id, p]));
  const patients = ['A', 'B', 'C', 'D', 'E', 'G', 'H', 'I'].map((id) => ({ ...pat(id), lead_id: id === 'E' ? 'L1' : null }));
  // Itens DONE concluídos por dentista (o fake não emula o filtro de dentista).
  const items = [
    { pid: 'A', proc: 'p1', date: '2026-07-13', by: 'Dra. Suellen' },
    { pid: 'C', proc: 'p2', date: '2026-05-10', by: 'Dr. X' },
    { pid: 'D', proc: 'p3', date: '2025-03-01', by: 'Dr. X' },
    { pid: 'B', proc: 'p4', date: '2026-08-12', by: 'Dra. Suellen' },
    { pid: 'H', proc: 'p6', date: '2026-09-01', by: 'Dra. Suellen' }, // clareamento caseiro (retorno desligado)
    { pid: 'I', proc: 'p7', date: '2026-02-01', by: 'Dra. Suellen' }, // faceta (fora de família)
  ];
  const events: Ev[] = [
    { start_at: d('2026-09-20'), title: 'Limpeza', patient_id: 'A', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Ana' } },
    { start_at: d('2026-06-01'), title: 'Consulta', patient_id: null, lead_id: 'L1', appointment_type: { name: 'Profilaxia' }, assigned_user: { name: 'Dra. Ana' } },
    { start_at: d('2026-06-02'), title: 'Limpeza de pele', patient_id: 'F', lead_id: null, appointment_type: null, assigned_user: null },
    { start_at: d('2026-04-15'), title: 'Retorno', patient_id: 'G', lead_id: null, appointment_type: null, assigned_user: null, tpi_proc: 'p1' },
    { start_at: d('2026-10-01'), title: 'Clareamento', patient_id: 'G', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Suellen' } },
    { start_at: d('2026-10-02'), title: 'Clareamento de axilas', patient_id: 'F', lead_id: null, appointment_type: null, assigned_user: null },
  ];
  const ilike = (s: string | null | undefined, t: string) => (s || '').toLowerCase().includes(t.toLowerCase());
  return {
    procedure: { findMany: jest.fn(async () => catalog) },
    treatmentPlanItem: {
      findMany: jest.fn(async (args: any) =>
        items
          .filter((it) =>
            args.where.procedure_id ? args.where.procedure_id.in.includes(it.proc) : P[it.proc].active, // bloco geral: procedure.active
          )
          .map((it) => ({
            executed_at: d(it.date),
            executed_by: { name: it.by },
            procedure: { id: it.proc, name: P[it.proc].name, default_revisit_months: P[it.proc].default_revisit_months },
            treatment_plan: { patient_id: it.pid, patient: pat(it.pid) },
          })),
      ),
    },
    calendarEvent: {
      // Emula o OR (ILIKE no título/tipo ou item vinculado) e o select filtrado dos itens.
      findMany: jest.fn(async (args: any) => {
        const ids: string[] = args.select.treatment_plan_items.where.procedure_id.in;
        return events
          .filter((e) =>
            args.where.OR.some((c: any) =>
              c.title ? ilike(e.title, c.title.contains)
              : c.appointment_type ? ilike(e.appointment_type?.name, c.appointment_type.name.contains)
              : !!e.tpi_proc && ids.includes(e.tpi_proc),
            ),
          )
          .map(({ tpi_proc, ...e }) => ({ ...e, treatment_plan_items: tpi_proc && ids.includes(tpi_proc) ? [{ id: 'tpi' }] : [] }));
      }),
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

const CATALOG: Proc[] = [
  { id: 'p1', name: 'Profilaxia (limpeza + raspagem)', category: 'PROFILAXIA', active: true, default_revisit_months: 6 },
  { id: 'p2', name: 'Limpeza', category: null, active: true, default_revisit_months: null },
  { id: 'p3', name: 'Limpeza antiga', category: null, active: false, default_revisit_months: 6 },
  { id: 'p4', name: 'Clareamento de Consultorio', category: 'ESTETICA_DENTAL', active: true, default_revisit_months: 12 },
  { id: 'p5', name: 'Limpeza de pele', category: 'LIMPEZA_PELE', active: true, default_revisit_months: 3 },
  { id: 'p6', name: 'Clareamento caseiro', category: null, active: true, default_revisit_months: null },
  { id: 'p7', name: 'Faceta de Resina (PREMIUM)', category: 'ESTETICA_DENTAL', active: true, default_revisit_months: 12 },
];
const clone = () => CATALOG.map((p) => ({ ...p }));
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe('ReturnAlertsService.getMaintenanceBoard — famílias (limpeza, clareamento)', () => {
  it('cada família numa aba só, com a próxima vinda da execução mais recente', async () => {
    const prisma = fakePrisma(clone());
    const board = await new ReturnAlertsService(prisma as any).getMaintenanceBoard(T);

    // Abas: "Limpeza"/arquivada/caseiro NÃO viram aba própria; estética de pele segue separada.
    expect(board.procedures).toEqual([
      'Clareamento de Consultorio', 'Faceta de Resina (PREMIUM)', 'Limpeza de pele', 'Profilaxia (limpeza + raspagem)',
    ]);
    const tab = (name: string) => Object.fromEntries(board.recalls.filter((r) => r.type === name).map((r) => [r.patient.id, r]));

    // LIMPEZA
    const limp = tab('Profilaxia (limpeza + raspagem)');
    expect(Object.keys(limp).sort()).toEqual(['A', 'C', 'D', 'E', 'G']); // F (limpeza de pele) fora
    expect(limp.A.source).toBe('agenda'); // plano 13/07, mas veio na agenda em 20/09 → a mais recente
    expect(limp.A.executed_by_name).toBe('Dra. Ana');
    expect(iso(limp.A.return_date)).toBe('2027-03-20');
    expect(iso(limp.C.return_date)).toBe('2026-11-10'); // "Limpeza" desligada → 6 meses da aba
    expect(iso(limp.D.return_date)).toBe('2025-09-01'); // limpeza arquivada
    expect(limp.E.source).toBe('agenda'); // consulta só com lead → paciente pelo lead
    expect(iso(limp.G.return_date)).toBe('2026-10-15'); // consulta vinculada a item de limpeza

    // CLAREAMENTO
    const clar = tab('Clareamento de Consultorio');
    expect(Object.keys(clar).sort()).toEqual(['B', 'G', 'H']); // F (clareamento de axilas) fora
    expect(iso(clar.B.return_date)).toBe('2027-08-12');
    expect(clar.H.months).toBe(12); // caseiro (desligado) entra com os 12 meses da aba
    expect(iso(clar.H.return_date)).toBe('2027-09-01');
    expect(clar.G.source).toBe('agenda');
    expect(clar.G.executed_by_name).toBe('Dra. Suellen');

    // Nada com o nome dos procedimentos absorvidos; resto do quadro igual (faceta do I).
    expect(board.recalls.some((r) => ['Limpeza', 'Limpeza antiga', 'Clareamento caseiro'].includes(r.type))).toBe(false);
    expect(Object.keys(tab('Faceta de Resina (PREMIUM)'))).toEqual(['I']);

    // A consulta à agenda é só do tenant, só clínica, só comparecido.
    for (const [args] of (prisma.calendarEvent.findMany as jest.Mock).mock.calls) {
      expect(args.where.tenant_id).toBe(T);
      expect(args.where.status.in).toEqual(['COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO']);
      expect(args.where.type.in).not.toContain('TAREFA');
    }
  });

  it('família sem procedimento ligado: quadro igual ao de antes (opt-in)', async () => {
    const cat = clone();
    cat.find((p) => p.id === 'p1')!.default_revisit_months = null;
    cat.find((p) => p.id === 'p4')!.default_revisit_months = null;
    const prisma = fakePrisma(cat);
    const board = await new ReturnAlertsService(prisma as any).getMaintenanceBoard(T);
    expect(board.procedures).toEqual(['Faceta de Resina (PREMIUM)', 'Limpeza de pele']);
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(board.recalls.map((r) => r.type)).toEqual(['Faceta de Resina (PREMIUM)']);
  });
});
