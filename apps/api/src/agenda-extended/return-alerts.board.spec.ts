import { ReturnAlertsService } from './return-alerts.service';

// Quadro de Retornos com banco FALSO: confere que cada FAMÍLIA (limpeza, clareamento, faceta, lentes,
// implante, protocolo) junta todos os procedimentos dela (outros nomes, arquivados) +
// consultas comparecidas na agenda numa aba só, e que procedimento ligado FORA de família
// segue a mesma regra (plano + agenda).
const T = '00000000-0000-0000-0000-000000000000';
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const pat = (id: string) => ({ id, name: `Paciente ${id}`, phone: null, avatar_url: null });

type Proc = { id: string; name: string; category: string | null; active: boolean; default_revisit_months: number | null };
type Ev = { start_at: Date; title: string; patient_id: string | null; lead_id: string | null; appointment_type: { name: string } | null; assigned_user: { name: string } | null; tpi_proc?: string };

function fakePrisma(catalog: Proc[]) {
  const P = Object.fromEntries(catalog.map((p) => [p.id, p]));
  const patients = ['A', 'B', 'C', 'D', 'E', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'].map((id) => ({ ...pat(id), lead_id: id === 'E' ? 'L1' : null }));
  // Itens DONE concluídos por dentista (o fake não emula o filtro de dentista).
  const items = [
    { pid: 'A', proc: 'p1', date: '2026-07-13', by: 'Dra. Suellen' },
    { pid: 'C', proc: 'p2', date: '2026-05-10', by: 'Dr. X' },
    { pid: 'D', proc: 'p3', date: '2025-03-01', by: 'Dr. X' },
    { pid: 'B', proc: 'p4', date: '2026-08-12', by: 'Dra. Suellen' },
    { pid: 'H', proc: 'p6', date: '2026-09-01', by: 'Dra. Suellen' }, // clareamento caseiro (retorno desligado)
    { pid: 'I', proc: 'p10', date: '2026-02-01', by: 'Dr. X' }, // restauração (fora de família, ligada)
    { pid: 'J', proc: 'p8', date: '2026-07-20', by: 'Dra. Suellen' }, // faceta resina simples (desligada)
    { pid: 'K', proc: 'p9', date: '2026-07-21', by: 'Dra. Suellen' }, // faceta de porcelana → lentes
    { pid: 'L', proc: 'p12', date: '2026-06-30', by: 'Dra. Suellen' }, // lente de resina → faceta de resina
    { pid: 'M', proc: 'p14', date: '2026-03-01', by: 'Dr. X' }, // coroa sobre implante → implante
    { pid: 'N', proc: 'p16', date: '2026-01-10', by: 'Dr. X' }, // protocolo cerâmica (desligado) → protocolo
    { pid: 'O', proc: 'p17', date: '2026-05-05', by: 'Dr. X' }, // remoção de implante → nenhum
    { pid: 'P', proc: 'p18', date: '2026-04-04', by: 'Dra. Suellen' }, // protocolo de clareamento → clareamento
  ];
  const events: Ev[] = [
    { start_at: d('2026-09-20'), title: 'Limpeza', patient_id: 'A', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Ana' } },
    { start_at: d('2026-06-01'), title: 'Consulta', patient_id: null, lead_id: 'L1', appointment_type: { name: 'Profilaxia' }, assigned_user: { name: 'Dra. Ana' } },
    { start_at: d('2026-06-02'), title: 'Limpeza de pele', patient_id: 'F', lead_id: null, appointment_type: null, assigned_user: null },
    { start_at: d('2026-04-15'), title: 'Retorno', patient_id: 'G', lead_id: null, appointment_type: null, assigned_user: null, tpi_proc: 'p1' },
    { start_at: d('2026-10-01'), title: 'Clareamento', patient_id: 'G', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Suellen' } },
    { start_at: d('2026-08-05'), title: 'Faceta', patient_id: 'C', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Suellen' } },
    { start_at: d('2026-08-06'), title: 'Remoção de faceta', patient_id: 'D', lead_id: null, appointment_type: null, assigned_user: null },
    { start_at: d('2026-09-10'), title: 'Lentes de porcelana - cimentação', patient_id: 'H', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Suellen' } },
    { start_at: d('2026-07-10'), title: 'Manutenção protocolo - remoção para higienização', patient_id: 'N', lead_id: null, appointment_type: null, assigned_user: { name: 'Dr. X' } },
    { start_at: d('2026-09-15'), title: 'Cirurgia de implante', patient_id: 'Q', lead_id: null, appointment_type: null, assigned_user: { name: 'Dr. X' } },
    { start_at: d('2026-09-16'), title: 'Avaliação para implante', patient_id: 'R', lead_id: null, appointment_type: null, assigned_user: { name: 'Dr. X' } },
    { start_at: d('2026-09-17'), title: 'Avaliação para clareamento', patient_id: 'S', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Suellen' } },
    { start_at: d('2026-09-18'), title: 'Avaliação + limpeza', patient_id: 'T', lead_id: null, appointment_type: null, assigned_user: { name: 'Dra. Ana' } },
    { start_at: d('2026-09-19'), title: 'Restauracao em resina - 36', patient_id: 'U', lead_id: null, appointment_type: null, assigned_user: { name: 'Dr. X' } },
    { start_at: d('2026-10-02'), title: 'Clareamento de axilas', patient_id: 'F', lead_id: null, appointment_type: null, assigned_user: null },
  ];
  const ilike = (s: string | null | undefined, t: string) => (s || '').toLowerCase().includes(t.toLowerCase());
  return {
    procedure: { findMany: jest.fn(async () => catalog) },
    treatmentPlanItem: {
      findMany: jest.fn(async (args: any) =>
        items
          .filter((it) => args.where.procedure_id.in.includes(it.proc))
          .map((it) => ({
            executed_at: d(it.date),
            procedure_id: it.proc,
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
          .map(({ tpi_proc, ...e }) => ({ ...e, treatment_plan_items: tpi_proc && ids.includes(tpi_proc) ? [{ procedure_id: tpi_proc }] : [] }));
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
  { id: 'p8', name: 'Faceta de resina simples', category: 'ESTETICA_DENTAL', active: true, default_revisit_months: null },
  { id: 'p9', name: 'Faceta de porcelana', category: 'ESTETICA_DENTAL', active: true, default_revisit_months: null },
  { id: 'p10', name: 'Restauração em resina', category: 'DENTISTICA', active: true, default_revisit_months: 12 },
  { id: 'p11', name: 'Lente de contato dental', category: 'ESTETICA_DENTAL', active: true, default_revisit_months: 12 },
  { id: 'p12', name: 'Lente de resina', category: 'ESTETICA_DENTAL', active: true, default_revisit_months: null },
  { id: 'p13', name: 'Implante dentário', category: 'IMPLANTE', active: true, default_revisit_months: 12 },
  { id: 'p14', name: 'Coroa sobre implante', category: 'PROTESE', active: true, default_revisit_months: null },
  { id: 'p15', name: 'Protocolo em resina', category: 'PROTESE', active: true, default_revisit_months: 6 },
  { id: 'p16', name: 'Protocolo cerâmica', category: 'PROTESE', active: true, default_revisit_months: null },
  { id: 'p17', name: 'Remoção de implante', category: 'CIRURGIA', active: true, default_revisit_months: null },
  { id: 'p18', name: 'Protocolo de clareamento', category: 'ESTETICA_DENTAL', active: true, default_revisit_months: null },
];
const clone = () => CATALOG.map((p) => ({ ...p }));
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe('ReturnAlertsService.getMaintenanceBoard — famílias (limpeza, clareamento, faceta, lentes, implante, protocolo)', () => {
  it('cada família numa aba só, com a próxima vinda da execução mais recente', async () => {
    const prisma = fakePrisma(clone());
    const board = await new ReturnAlertsService(prisma as any).getMaintenanceBoard(T);

    // Abas: "Limpeza"/arquivada/caseiro NÃO viram aba própria; estética de pele segue separada.
    expect(board.procedures).toEqual([
      'Clareamento de Consultorio', 'Faceta de Resina (PREMIUM)', 'Implante dentário', 'Lente de contato dental', 'Limpeza de pele',
      'Profilaxia (limpeza + raspagem)', 'Protocolo em resina', 'Restauração em resina',
    ]);
    const tab = (name: string) => Object.fromEntries(board.recalls.filter((r) => r.type === name).map((r) => [r.patient.id, r]));

    // LIMPEZA
    const limp = tab('Profilaxia (limpeza + raspagem)');
    expect(Object.keys(limp).sort()).toEqual(['A', 'C', 'D', 'E', 'G', 'T']); // F (limpeza de pele) fora; T = avaliação + limpeza
    expect(limp.A.source).toBe('agenda'); // plano 13/07, mas veio na agenda em 20/09 → a mais recente
    expect(limp.A.executed_by_name).toBe('Dra. Ana');
    expect(iso(limp.A.return_date)).toBe('2027-03-20');
    expect(iso(limp.C.return_date)).toBe('2026-11-10'); // "Limpeza" desligada → 6 meses da aba
    expect(iso(limp.D.return_date)).toBe('2025-09-01'); // limpeza arquivada
    expect(limp.E.source).toBe('agenda'); // consulta só com lead → paciente pelo lead
    expect(iso(limp.G.return_date)).toBe('2026-10-15'); // consulta vinculada a item de limpeza

    // CLAREAMENTO
    const clar = tab('Clareamento de Consultorio');
    expect(Object.keys(clar).sort()).toEqual(['B', 'G', 'H', 'P']); // F (axilas) e S (só avaliação) fora; P = protocolo de clareamento
    expect(iso(clar.B.return_date)).toBe('2027-08-12');
    expect(clar.H.months).toBe(12); // caseiro (desligado) entra com os 12 meses da aba
    expect(iso(clar.H.return_date)).toBe('2027-09-01');
    expect(clar.G.source).toBe('agenda');
    expect(clar.G.executed_by_name).toBe('Dra. Suellen');

    // FACETA DE RESINA
    const fac = tab('Faceta de Resina (PREMIUM)');
    expect(Object.keys(fac).sort()).toEqual(['C', 'J', 'L']); // K (porcelana) e D (remoção) fora; L = lente de resina
    expect(fac.J.months).toBe(12); // resina simples (desligada) entra com os 12 meses da aba
    expect(iso(fac.J.return_date)).toBe('2027-07-20');
    expect(fac.C.source).toBe('agenda');
    expect(iso(fac.C.return_date)).toBe('2027-08-05');

    // LENTES DE PORCELANA
    const len = tab('Lente de contato dental');
    expect(Object.keys(len).sort()).toEqual(['H', 'K']); // L (lente de resina) fora
    expect(iso(len.K.return_date)).toBe('2027-07-21'); // faceta de porcelana (desligada) entra
    expect(len.H.source).toBe('agenda');
    expect(iso(len.H.return_date)).toBe('2027-09-10');

    // IMPLANTE
    const imp = tab('Implante dentário');
    expect(Object.keys(imp).sort()).toEqual(['M', 'Q']); // O (remoção) e R (avaliação) fora
    expect(iso(imp.M.return_date)).toBe('2027-03-01'); // coroa sobre implante, 12 meses da aba
    expect(imp.Q.source).toBe('agenda');

    // PROTOCOLO (cerâmica ou resina)
    const pro = tab('Protocolo em resina');
    expect(Object.keys(pro)).toEqual(['N']);
    expect(pro.N.source).toBe('agenda'); // remoção pra higienização (jul) é mais recente que o protocolo (jan)
    expect(pro.N.months).toBe(6);
    expect(iso(pro.N.return_date)).toBe('2027-01-10');

    // Nada com o nome dos procedimentos absorvidos; resto do quadro igual (restauração do I).
    expect(board.recalls.some((r) => ['Limpeza', 'Limpeza antiga', 'Clareamento caseiro', 'Faceta de resina simples', 'Faceta de porcelana', 'Lente de resina', 'Coroa sobre implante', 'Protocolo cerâmica', 'Remoção de implante', 'Protocolo de clareamento'].includes(r.type))).toBe(false);
    // Procedimento ligado FORA de família: plano (I) + consulta com o nome dele, sem acento (U).
    const res = tab('Restauração em resina');
    expect(Object.keys(res).sort()).toEqual(['I', 'U']);
    expect(res.U.source).toBe('agenda');
    expect(iso(res.U.return_date)).toBe('2027-09-19');
    // Poucas queries: 1 busca de itens e 1 de agenda pra TODAS as abas.
    expect(prisma.treatmentPlanItem.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEvent.findMany).toHaveBeenCalledTimes(1);

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
    cat.find((p) => p.id === 'p7')!.default_revisit_months = null;
    cat.find((p) => p.id === 'p11')!.default_revisit_months = null;
    cat.find((p) => p.id === 'p13')!.default_revisit_months = null;
    cat.find((p) => p.id === 'p15')!.default_revisit_months = null;
    const prisma = fakePrisma(cat);
    const board = await new ReturnAlertsService(prisma as any).getMaintenanceBoard(T);
    expect(board.procedures).toEqual(['Limpeza de pele', 'Restauração em resina']);
    expect(Array.from(new Set(board.recalls.map((r) => r.type)))).toEqual(['Restauração em resina']);
  });
});
