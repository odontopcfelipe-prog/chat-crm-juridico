import { RetornoDisparosService, chipForaDoAr, numeroSemWhatsapp, wasSent } from './retorno-disparos.service';

// Motor dos disparos de retorno com banco e WhatsApp FALSOS.
const T = 'T1';
// "agora" = 13/01/2027 10:00 em Maceió (13:00 UTC), quarta-feira.
const AGORA = new Date('2027-01-13T13:00:00Z');
const d = (s: string) => new Date(`${s}T12:00:00Z`);

type Pac = { id: string; name: string; phone: string | null; status: string; lead_id: string | null; lead: { contact_opt_out_at: Date | null } | null };

function cenario(over: Partial<{
  recalls: any[];
  pacientes: Pac[];
  eventos: { patient_id: string | null; lead_id: string | null }[];
  marcas: { entity_id: string; action: string }[];
  recentes: string[];
  ligados: string[];
  enviadosHoje: number;
  feriado: boolean;
  vezDoChip: boolean;
  respostaEnvio: any;
}> = {}) {
  const o = {
    recalls: [
      // A: limpeza feita 13/07/2026 → prevista 13/01/2027 = HOJE (no dia)
      { kind: 'procedure', family: 'limpeza', patient: { id: 'A', name: 'Ana Souza' }, last_date: d('2026-07-13'), return_date: d('2027-01-13') },
      // B: limpeza prevista 20/01 → 7 dias antes (antes)
      { kind: 'procedure', family: 'limpeza', patient: { id: 'B', name: 'Bia' }, last_date: d('2026-07-20'), return_date: d('2027-01-20') },
      // C: clareamento previsto 29/12/2026 → 15 dias depois (depois)
      { kind: 'procedure', family: 'clareamento', patient: { id: 'C', name: 'Caio' }, last_date: d('2025-12-29'), return_date: d('2026-12-29') },
      // D: limpeza com consulta marcada (suspenso)
      { kind: 'procedure', family: 'limpeza', patient: { id: 'D', name: 'Davi' }, last_date: d('2026-07-14'), return_date: d('2027-01-14') },
      // E: limpeza, contato com consulta marcada pelo LEAD (suspenso)
      { kind: 'procedure', family: 'limpeza', patient: { id: 'E', name: 'Eva' }, last_date: d('2026-07-15'), return_date: d('2027-01-15') },
      // F: implante (fora dos disparos)
      { kind: 'procedure', family: 'implante', patient: { id: 'F', name: 'Fabi' }, last_date: d('2026-01-13'), return_date: d('2027-01-13') },
      // G: limpeza 80 dias atrasada (fora de todas as janelas)
      { kind: 'procedure', family: 'limpeza', patient: { id: 'G', name: 'Gil' }, last_date: d('2026-04-25'), return_date: d('2026-10-25') },
      // H: sem telefone · I: pediu pra não receber · J: recebeu aviso há 1 dia
      { kind: 'procedure', family: 'limpeza', patient: { id: 'H', name: 'Hugo' }, last_date: d('2026-07-13'), return_date: d('2027-01-13') },
      { kind: 'procedure', family: 'limpeza', patient: { id: 'I', name: 'Iara' }, last_date: d('2026-07-13'), return_date: d('2027-01-13') },
      { kind: 'procedure', family: 'limpeza', patient: { id: 'J', name: 'João' }, last_date: d('2026-07-13'), return_date: d('2027-01-13') },
      // Tratamento concluído (kind completion) nunca entra
      { kind: 'completion', patient: { id: 'K', name: 'Kai' }, last_date: null, return_date: d('2027-01-13') },
    ],
    pacientes: (['A', 'B', 'C', 'D', 'E', 'G', 'J', 'K'].map((id) => ({
      id, name: `Paciente ${id}`, phone: `8299999000${id.charCodeAt(0) % 10}`, status: 'ACTIVE', lead_id: id === 'E' ? 'LE' : null, lead: null,
    })) as Pac[]).concat([
      { id: 'H', name: 'Hugo', phone: null, status: 'ACTIVE', lead_id: null, lead: null },
      { id: 'I', name: 'Iara', phone: '82999990009', status: 'ACTIVE', lead_id: 'LI', lead: { contact_opt_out_at: new Date('2026-01-01') } },
    ]) as Pac[],
    eventos: [{ patient_id: 'D', lead_id: null }, { patient_id: null, lead_id: 'LE' }],
    marcas: [] as { entity_id: string; action: string }[],
    recentes: ['J'],
    ligados: ['RETORNO_LIMPEZA_NO_DIA_ENABLED_T1', 'RETORNO_LIMPEZA_ANTES_ENABLED_T1', 'RETORNO_CLAREAMENTO_DEPOIS_ENABLED_T1'],
    enviadosHoje: 0,
    feriado: false,
    vezDoChip: true,
    respostaEnvio: { key: { id: 'MSG1' } } as any,
    ...over,
  };
  const audit: any[] = o.marcas.map((m, i) => ({ id: `m${i}`, ...m, entity: 'RETORNO_DISPARO', tenant_id: T }));
  const dispatch: any[] = [];
  const prisma: any = {
    globalSetting: { findMany: jest.fn(async () => o.ligados.map((key) => ({ key }))) },
    auditLog: {
      findMany: jest.fn(async (a: any) => audit.filter((x) => a.where.entity_id.in.includes(x.entity_id))),
      count: jest.fn(async (a: any) => audit.filter((x) => x.entity_id === a.where.entity_id && x.action === a.where.action).length),
      create: jest.fn(async (a: any) => { const r = { id: `m${audit.length}`, ...a.data }; audit.push(r); return r; }),
      delete: jest.fn(async (a: any) => { const i = audit.findIndex((x) => x.id === a.where.id); if (i >= 0) audit.splice(i, 1); }),
    },
    patient: {
      findMany: jest.fn(async (a: any) => o.pacientes.filter((p) => a.where.id.in.includes(p.id))),
      findFirst: jest.fn(async (a: any) => o.pacientes.find((p) => p.id === a.where.id) || null),
    },
    dispatchLog: {
      findMany: jest.fn(async (a: any) => o.recentes.filter((id) => a.where.ref_patient_id.in.includes(id)).map((id) => ({ ref_patient_id: id }))),
      count: jest.fn(async () => o.enviadosHoje),
      create: jest.fn(async (a: any) => { dispatch.push(a.data); return a.data; }),
    },
    calendarEvent: {
      findMany: jest.fn(async () => o.eventos),
      count: jest.fn(async (a: any) => o.eventos.filter((e) => a.where.OR.some((c: any) => (c.patient_id && c.patient_id === e.patient_id) || (c.lead_id && c.lead_id === e.lead_id))).length),
    },
    holiday: { findFirst: jest.fn(async () => (o.feriado ? { name: 'Feriado X' } : null)) },
    $queryRaw: jest.fn(async () => []),
    instance: { findMany: jest.fn(async () => [{ name: 'fin', purpose: 'FINANCEIRO' }, { name: 'clin', purpose: 'CLINICA' }]) },
    whatsappChipPacer: {
      createMany: jest.fn(async () => ({ count: 0 })),
      updateMany: jest.fn(async (a: any) => ({ count: a.where.next_allowed_at ? (o.vezDoChip ? 1 : 0) : 1 })),
    },
    tenantSetting: { findUnique: jest.fn(async () => null) },
    tenant: { findUnique: jest.fn(async () => ({ name: 'Instituto Teste' })) },
  };
  const board = { getMaintenanceBoard: jest.fn(async () => ({ procedures: [], recalls: o.recalls })) };
  const whatsapp = { sendText: jest.fn(async () => o.respostaEnvio) };
  const svc = new RetornoDisparosService(prisma, board as any, whatsapp as any);
  return { svc, prisma, whatsapp, audit, dispatch, board };
}

describe('RetornoDisparosService', () => {
  it('lê os toques ligados por clínica (só true)', async () => {
    const { svc } = cenario();
    const m = await svc.ligadosPorClinica();
    expect(Array.from(m.get(T) || []).sort()).toEqual(['retorno_clareamento_depois', 'retorno_limpeza_antes', 'retorno_limpeza_no_dia']);
  });

  it('avalia a janela de hoje e a situação de cada paciente', async () => {
    const { svc } = cenario();
    const ligados = (await svc.ligadosPorClinica()).get(T)!;
    const lista = await svc.avaliar(T, ligados, AGORA);
    const sit = Object.fromEntries(lista.map((c) => [c.patientId, `${c.id}:${c.situacao}`]));
    expect(sit).toEqual({
      A: 'retorno_limpeza_no_dia:na_fila',
      B: 'retorno_limpeza_antes:na_fila',
      C: 'retorno_clareamento_depois:na_fila',
      D: 'retorno_limpeza_antes:agendado', // prevista amanhã → antes; tem consulta → suspenso
      E: 'retorno_limpeza_antes:agendado', // consulta marcada pelo contato (lead)
      H: 'retorno_limpeza_no_dia:sem_telefone',
      I: 'retorno_limpeza_no_dia:nao_recebe',
      J: 'retorno_limpeza_no_dia:recente',
    }); // F (implante), G (fora das janelas) e K (concluído) nem entram
    // fila: quem perde a janela primeiro; empate (A no dia e B 7 dias antes têm 6 dias de
    // janela) → a data prevista mais cedo. C (depois) ainda tem 30 dias.
    const fila = lista.filter((c) => c.situacao === 'na_fila').map((c) => c.patientId);
    expect(fila).toEqual(['A', 'B', 'C']);
  });

  it('toque desligado não entra; toque já enviado aparece como já recebeu', async () => {
    const { svc } = cenario({
      ligados: ['RETORNO_LIMPEZA_NO_DIA_ENABLED_T1'],
      marcas: [{ entity_id: 'A:limpeza:2027-01-13', action: 'no_dia' }],
    });
    const lista = await svc.avaliar(T, (await svc.ligadosPorClinica()).get(T)!, AGORA);
    expect(lista.find((c) => c.patientId === 'A')?.situacao).toBe('ja_recebeu');
    expect(lista.some((c) => c.patientId === 'B' || c.patientId === 'C')).toBe(false);
  });

  it('envia 1 por tick pelo chip da Clínica, marca o toque e registra', async () => {
    const { svc, whatsapp, audit, dispatch } = cenario();
    await svc.rodar(AGORA);
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    const [phone, texto, chip, , tenant] = (whatsapp.sendText as jest.Mock).mock.calls[0];
    expect(chip).toBe('clin'); // nunca o Financeiro
    expect(tenant).toBe(T);
    expect(phone).toBeTruthy();
    // A (limpeza no dia): feito 13/07/2026 → "6 meses" hoje
    expect(texto).toMatch(/^Oi, Paciente!/);
    expect(texto).toContain('6 meses');
    expect(audit.map((a) => `${a.entity_id}|${a.action}`)).toEqual(['A:limpeza:2027-01-13|no_dia']);
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]).toMatchObject({ tenant_id: T, type: 'retorno_limpeza_no_dia', status: 'SENT', ref_patient_id: 'A', external_message_id: 'MSG1' });
  });

  it('toque "antes" leva a data prevista e o nome da clínica', async () => {
    const { svc, whatsapp } = cenario({ ligados: ['RETORNO_LIMPEZA_ANTES_ENABLED_T1'] });
    await svc.rodar(AGORA);
    const texto = (whatsapp.sendText as jest.Mock).mock.calls[0][1];
    // B: feito 20/07/2026 → 5 meses em 13/01; prevista 20/01/2027
    expect(texto).toContain('5 meses');
    expect(texto).toContain('20/01/2027');
    expect(texto).toContain('Instituto Teste');
  });

  it('não é a vez do chip (marca-passo) → não envia nada', async () => {
    const { svc, whatsapp } = cenario({ vezDoChip: false });
    await svc.rodar(AGORA);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('teto do dia, feriado e fora do horário seguram o envio', async () => {
    for (const over of [{ enviadosHoje: 40 }, { feriado: true }]) {
      const { svc, whatsapp } = cenario(over);
      await svc.rodar(AGORA);
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    }
    const { svc, whatsapp } = cenario();
    await svc.rodar(new Date('2027-01-13T22:30:00Z')); // 19:30 em Maceió
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('chip fora do ar: desfaz a marca (tenta depois) e não registra envio', async () => {
    const { svc, audit, dispatch, prisma } = cenario({ respostaEnvio: { statusCode: 428, error: 'Connection Closed' } });
    await svc.rodar(AGORA);
    expect(audit).toHaveLength(0);
    expect(dispatch).toHaveLength(0);
    // pausa o chip 30 min
    const pausa = (prisma.whatsappChipPacer.updateMany as jest.Mock).mock.calls.at(-1)[0];
    expect(pausa.data.next_allowed_at.getTime() - AGORA.getTime()).toBe(30 * 60_000);
  });

  it('número sem WhatsApp: fica FALHOU e o toque não repete', async () => {
    const { svc, audit, dispatch } = cenario({
      respostaEnvio: { statusCode: 400, error: '{"status":400,"response":{"message":[{"exists":false,"number":"55829"}]}}' },
    });
    await svc.rodar(AGORA);
    expect(audit).toHaveLength(1);
    expect(dispatch[0]).toMatchObject({ status: 'FAILED', error: 'número sem WhatsApp' });
  });

  it('agendou entre a avaliação e o envio → pula (reconferência ao vivo)', async () => {
    const c = cenario();
    // a avaliação não vê consulta do B, mas na hora do envio ela existe
    c.prisma.calendarEvent.count = jest.fn(async () => 1);
    await c.svc.rodar(AGORA);
    expect(c.whatsapp.sendText).not.toHaveBeenCalled();
    expect(c.audit).toHaveLength(0);
  });

  it('classificação da resposta da Evolution', () => {
    expect(wasSent({ key: { id: 'x' } })).toBe(true);
    expect(wasSent({ statusCode: 400, error: 'x' })).toBe(false);
    expect(numeroSemWhatsapp({ statusCode: 400, error: '{"exists":false}' })).toBe(true);
    expect(chipForaDoAr({ statusCode: 428, error: 'Connection Closed' })).toBe(true);
    expect(chipForaDoAr({ statusCode: 404, error: 'instance does not exist' })).toBe(true);
    expect(chipForaDoAr({ statusCode: 408, error: 'Request timeout after 15000ms' })).toBe(false); // pode ter saído
    expect(chipForaDoAr({ statusCode: 500, error: 'internal' })).toBe(false);
  });
});
