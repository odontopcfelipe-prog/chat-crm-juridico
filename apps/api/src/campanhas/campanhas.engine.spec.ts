import { CampanhasEnvioService } from './campanhas-envio.service';
import { CampanhasService } from './campanhas.service';

// Motor + serviço da campanha manual com banco, WhatsApp e disco FALSOS (em memória).
const T = 'T1';
const AGORA = new Date('2027-01-13T13:00:00Z'); // 10:00 em Maceió, quarta

function banco(over: Partial<{ chips: any[]; feriado: boolean; enviadosHoje: number; vez: boolean }> = {}) {
  const o = { chips: [{ name: 'clin', purpose: 'CLINICA' }, { name: 'fin', purpose: 'FINANCEIRO' }], feriado: false, enviadosHoje: 0, vez: true, ...over };
  const camp: any[] = [];
  const itens: any[] = [];
  const midias: any[] = [];
  const logs: any[] = [];
  const pacientes: any[] = [
    { id: 'P1', tenant_id: T, name: 'Ana Souza', phone: '82999990001', status: 'ACTIVE', birth_date: null, lead: null },
    { id: 'P2', tenant_id: T, name: 'Bia Lima', phone: '82999990002', status: 'ACTIVE', birth_date: null, lead: { contact_opt_out_at: new Date(), whatsapp_invalid_at: null, non_patient_category: null } },
    { id: 'P3', tenant_id: T, name: 'Caio', phone: '82999990003', status: 'ACTIVE', birth_date: null, lead: null },
    { id: 'P4', tenant_id: T, name: 'Sem Fone', phone: null, status: 'ACTIVE', birth_date: null, lead: null },
  ];
  const match = (row: any, where: any): boolean =>
    Object.entries(where || {}).every(([k, v]: [string, any]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(row[k]);
        if ('lte' in v) return row[k] != null && row[k] <= v.lte;
        if ('lt' in v) return row[k] != null && row[k] < v.lt;
        if ('gte' in v) return row[k] != null && row[k] >= v.gte;
        return true;
      }
      return row[k] === v;
    });
  const upd = (rows: any[], a: any) => {
    const alvo = rows.filter((r) => match(r, a.where));
    for (const r of alvo) {
      for (const [k, v] of Object.entries(a.data)) {
        r[k] = v && typeof v === 'object' && 'increment' in (v as any) ? (r[k] || 0) + (v as any).increment : v;
      }
    }
    return { count: alvo.length };
  };
  const prisma: any = {
    manualCampaign: {
      create: jest.fn(async (a: any) => { const r = { id: `C${camp.length + 1}`, status: 'RASCUNHO', total: 0, sent_count: 0, failed_count: 0, skipped_count: 0, created_at: new Date(), started_at: null, scheduled_for: null, ...a.data }; camp.push(r); return r; }),
      findFirst: jest.fn(async (a: any) => camp.find((r) => match(r, a.where)) || null),
      findMany: jest.fn(async (a: any) => camp.filter((r) => match(r, a.where))),
      update: jest.fn(async (a: any) => { upd(camp, a); return camp.find((r) => r.id === a.where.id); }),
      updateMany: jest.fn(async (a: any) => upd(camp, a)),
      delete: jest.fn(async (a: any) => { const i = camp.findIndex((r) => r.id === a.where.id); camp.splice(i, 1); }),
    },
    manualCampaignItem: {
      count: jest.fn(async (a: any) => itens.filter((r) => match(r, a.where)).length),
      findFirst: jest.fn(async (a: any) => itens.find((r) => match(r, a.where)) || null),
      findMany: jest.fn(async (a: any) => itens.filter((r) => match(r, a.where))),
      update: jest.fn(async (a: any) => { upd(itens, a); }),
      updateMany: jest.fn(async (a: any) => upd(itens, a)),
      createMany: jest.fn(async (a: any) => { for (const d of a.data) itens.push({ id: `I${itens.length + 1}`, status: 'PENDENTE', created_at: new Date(Date.now() + itens.length), ...d }); return { count: a.data.length }; }),
      groupBy: jest.fn(async () => []),
    },
    manualCampaignMedia: {
      findMany: jest.fn(async (a: any) => midias.filter((r) => match(r, a.where))),
      count: jest.fn(async (a: any) => midias.filter((r) => match(r, a.where)).length),
      create: jest.fn(async (a: any) => { midias.push(a.data); return a.data; }),
    },
    patient: {
      findFirst: jest.fn(async (a: any) => pacientes.find((p) => p.id === a.where.id && p.tenant_id === a.where.tenant_id) || null),
      findMany: jest.fn(async () => pacientes),
    },
    dispatchLog: { count: jest.fn(async () => o.enviadosHoje), create: jest.fn(async (a: any) => { logs.push(a.data); }) },
    instance: { findMany: jest.fn(async () => o.chips) },
    whatsappChipPacer: {
      createMany: jest.fn(async () => ({ count: 0 })),
      updateMany: jest.fn(async (a: any) => ({ count: a.where.next_allowed_at ? (o.vez ? 1 : 0) : 1 })),
    },
    tenant: { findUnique: jest.fn(async () => ({ name: 'Instituto Teste' })) },
    holiday: { findFirst: jest.fn(async () => (o.feriado ? { name: 'Feriado' } : null)) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const enviados: { tipo: string; para: string; chip: string; conteudo: any }[] = [];
  let resposta: (tipo: string) => any = () => ({ key: { id: 'MSG' } });
  const whatsapp: any = {
    sendText: jest.fn(async (para: string, texto: string, chip: string) => { enviados.push({ tipo: 'texto', para, chip, conteudo: texto }); return resposta('texto'); }),
    sendMedia: jest.fn(async (para: string, tipo: string, _b64: string, legenda: string, chip: string) => { enviados.push({ tipo, para, chip, conteudo: legenda }); return resposta(tipo); }),
  };
  const disco: Record<string, Buffer> = {};
  const files: any = {
    write: jest.fn(async (p: string, b: Buffer) => { disco[p] = b; }),
    read: jest.fn(async (p: string) => disco[p] || Buffer.from('x')),
    delete: jest.fn(async (p: string) => { delete disco[p]; }),
  };
  const envio = new CampanhasEnvioService(prisma, whatsapp, files);
  (envio as any).constructor; // eslint
  const svc = new CampanhasService(prisma, files, envio);
  return { prisma, envio, svc, camp, itens, midias, logs, enviados, whatsapp, files, setResposta: (f: any) => { resposta = f; } };
}

jest.setTimeout(20000);
beforeAll(() => jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any));
afterAll(() => (global.setTimeout as any).mockRestore?.());

describe('Campanha manual — serviço', () => {
  it('iniciar congela só quem recebe, uma vez só (duplo clique não duplica)', async () => {
    const b = banco();
    const c = await b.svc.criar(T, 'U1', { name: 'Promo', setor: 'CLINICA', text: 'Oi {nome}' });
    await b.svc.iniciar(T, c.id, null);
    expect(b.camp[0].status).toBe('ENVIANDO');
    expect(b.camp[0].total).toBe(2); // P2 (opt-out) e P4 (sem telefone) ficam fora
    expect(b.itens.map((i) => i.patient_id).sort()).toEqual(['P1', 'P3']);
    await expect(b.svc.iniciar(T, c.id, null)).rejects.toThrow(/rascunho/);
    expect(b.itens).toHaveLength(2);
  });

  it('agendar pro futuro deixa AGENDADA; sem texto e sem anexo não inicia; sem chip do setor não inicia', async () => {
    const b = banco({ chips: [{ name: 'clin', purpose: 'CLINICA' }] });
    const c = await b.svc.criar(T, 'U1', { setor: 'CLINICA', text: 'Oi' });
    await b.svc.iniciar(T, c.id, new Date(Date.now() + 3 * 864e5).toISOString());
    expect(b.camp[0].status).toBe('AGENDADA');
    const vazia = await b.svc.criar(T, 'U1', { setor: 'CLINICA', text: '   ' });
    await expect(b.svc.iniciar(T, vazia.id, null)).rejects.toThrow(/mensagem ou anexe/);
    const fin = await b.svc.criar(T, 'U1', { setor: 'FINANCEIRO', text: 'Oi' });
    await expect(b.svc.iniciar(T, fin.id, null)).rejects.toThrow(/chip/);
  });

  it('anexo: só foto/áudio, tamanho por tipo, máx. 3, só em rascunho', async () => {
    const b = banco();
    const c = await b.svc.criar(T, 'U1', { setor: 'CLINICA', text: 'Oi' });
    const foto = { buffer: Buffer.from('img'), mimetype: 'image/jpeg', size: 1000, originalname: 'promo.jpg' };
    await b.svc.anexar(T, c.id, foto);
    expect(b.midias[0]).toMatchObject({ kind: 'image', file_path: expect.stringMatching(new RegExp(`^campanhas/${c.id}/.+\\.jpg$`)) });
    await expect(b.svc.anexar(T, c.id, { ...foto, mimetype: 'application/pdf' })).rejects.toThrow(/Só fotos/);
    await expect(b.svc.anexar(T, c.id, { ...foto, size: 6 * 1024 * 1024 })).rejects.toThrow(/muito grande/);
    await b.svc.anexar(T, c.id, { buffer: Buffer.from('a'), mimetype: 'audio/ogg', size: 2000, originalname: 'recado.ogg' });
    await b.svc.anexar(T, c.id, foto);
    await expect(b.svc.anexar(T, c.id, foto)).rejects.toThrow(/Máximo/);
    b.camp[0].status = 'ENVIANDO';
    await expect(b.svc.atualizar(T, c.id, { text: 'outro' })).rejects.toThrow(/rascunho/);
  });

  it('campanha de outra clínica não é encontrada', async () => {
    const b = banco();
    const c = await b.svc.criar('OUTRA', 'U1', { setor: 'CLINICA', text: 'Oi' });
    await expect(b.svc.detalhe(T, c.id)).rejects.toThrow(/não encontrada/);
  });
});

describe('Campanha manual — motor', () => {
  async function pronta(b: ReturnType<typeof banco>, setor = 'CLINICA') {
    const c = await b.svc.criar(T, 'U1', { setor, text: 'Oi, {nome}! Aqui é da equipe {clinica}.' });
    await b.svc.anexar(T, c.id, { buffer: Buffer.from('i'), mimetype: 'image/png', size: 10, originalname: 'f.png' });
    await b.svc.anexar(T, c.id, { buffer: Buffer.from('a'), mimetype: 'audio/mpeg', size: 10, originalname: 'r.mp3' });
    await b.svc.iniciar(T, c.id, null);
    return c;
  }

  it('1 paciente por rodada: foto com o texto de legenda, depois o áudio, pelo chip do setor', async () => {
    const b = banco();
    await pronta(b);
    await b.envio.rodar(AGORA);
    expect(b.enviados.map((e) => e.tipo)).toEqual(['image', 'audio']);
    expect(b.enviados[0]).toMatchObject({ para: '82999990001', chip: 'clin', conteudo: 'Oi, Ana! Aqui é da equipe Instituto Teste.' });
    expect(b.itens.find((i) => i.patient_id === 'P1')).toMatchObject({ status: 'ENVIADO', external_message_id: 'MSG' });
    expect(b.itens.find((i) => i.patient_id === 'P3')?.status).toBe('PENDENTE'); // o próximo espera a vez do chip
    expect(b.camp[0].sent_count).toBe(1);
    expect(b.logs[0]).toMatchObject({ type: 'campanha_manual', status: 'SENT', ref_patient_id: 'P1', tenant_id: T });
  });

  it('não é a vez do chip / fora do horário / feriado / teto → não envia', async () => {
    for (const over of [{ vez: false }, { feriado: true }, { enviadosHoje: 120 }]) {
      const b = banco(over);
      await pronta(b);
      await b.envio.rodar(AGORA);
      expect(b.enviados).toHaveLength(0);
    }
    const b = banco();
    await pronta(b);
    await b.envio.rodar(new Date('2027-01-13T22:00:00Z')); // 19h em Maceió
    expect(b.enviados).toHaveLength(0);
  });

  it('pediu pra não receber DEPOIS de iniciar → pula e já tenta o próximo na mesma rodada', async () => {
    const b = banco();
    await pronta(b);
    (await b.prisma.patient.findFirst({ where: { id: 'P1', tenant_id: T } })).lead = { contact_opt_out_at: new Date(), whatsapp_invalid_at: null, non_patient_category: null };
    await b.envio.rodar(AGORA);
    expect(b.itens.find((i) => i.patient_id === 'P1')).toMatchObject({ status: 'PULADO', reason: 'pediu pra não receber' });
    expect(b.itens.find((i) => i.patient_id === 'P3')?.status).toBe('ENVIADO');
    expect(b.camp[0]).toMatchObject({ skipped_count: 1, sent_count: 1 });
  });

  it('chip fora do ar: o paciente volta pra fila e o chip pausa 30 min', async () => {
    const b = banco();
    await pronta(b);
    b.setResposta(() => ({ statusCode: 428, error: 'Connection Closed' }));
    await b.envio.rodar(AGORA);
    expect(b.itens.every((i) => i.status === 'PENDENTE')).toBe(true);
    const pausa = (b.prisma.whatsappChipPacer.updateMany as jest.Mock).mock.calls.at(-1)[0];
    expect(pausa.data.next_allowed_at.getTime() - AGORA.getTime()).toBe(30 * 60_000);
    expect(b.logs).toHaveLength(0);
  });

  it('número sem WhatsApp na 1ª bolha → FALHOU e não manda o resto', async () => {
    const b = banco();
    await pronta(b);
    b.setResposta(() => ({ statusCode: 400, error: '{"response":{"message":[{"exists":false}]}}' }));
    await b.envio.rodar(AGORA);
    expect(b.enviados).toHaveLength(1);
    expect(b.itens.find((i) => i.patient_id === 'P1')).toMatchObject({ status: 'FALHOU', reason: 'número sem WhatsApp' });
    expect(b.camp[0].failed_count).toBe(1);
  });

  it('áudio falhou mas a foto saiu → ENVIADO com aviso', async () => {
    const b = banco();
    await pronta(b);
    b.setResposta((tipo: string) => (tipo === 'audio' ? { statusCode: 500, error: 'ffmpeg' } : { key: { id: 'MSG' } }));
    await b.envio.rodar(AGORA);
    expect(b.itens.find((i) => i.patient_id === 'P1')).toMatchObject({ status: 'ENVIADO', reason: expect.stringMatching(/áudio/) });
  });

  it('sem chip do setor → campanha PAUSADA com o motivo; acabou a fila → CONCLUIDA; agendada que venceu → começa', async () => {
    const b = banco();
    await pronta(b, 'FINANCEIRO');
    b.prisma.instance.findMany = jest.fn(async () => [{ name: 'clin', purpose: 'CLINICA' }]);
    await b.envio.rodar(AGORA);
    expect(b.camp[0]).toMatchObject({ status: 'PAUSADA', pause_reason: expect.stringMatching(/Financeiro/) });

    const b2 = banco();
    const c2 = await pronta(b2);
    for (const i of b2.itens) i.status = 'ENVIADO';
    await b2.envio.rodar(AGORA);
    expect(b2.camp.find((c) => c.id === c2.id)?.status).toBe('CONCLUIDA');

    const b3 = banco();
    const c3 = await b3.svc.criar(T, 'U1', { setor: 'CLINICA', text: 'Oi' });
    await b3.svc.iniciar(T, c3.id, new Date(AGORA.getTime() + 864e5).toISOString());
    b3.camp[0].scheduled_for = new Date(AGORA.getTime() - 60_000);
    await b3.envio.rodar(AGORA);
    expect(b3.camp[0].status).toBe('ENVIANDO');
    expect(b3.enviados.length).toBeGreaterThan(0);
  });

  it('pausar/retomar/cancelar: cancelar pula quem estava na fila', async () => {
    const b = banco();
    const c = await pronta(b);
    await b.svc.pausar(T, c.id);
    expect(b.camp[0].status).toBe('PAUSADA');
    await b.envio.rodar(AGORA);
    expect(b.enviados).toHaveLength(0);
    await b.svc.retomar(T, c.id);
    expect(b.camp[0].status).toBe('ENVIANDO');
    await b.svc.cancelar(T, c.id);
    expect(b.camp[0].status).toBe('CANCELADA');
    expect(b.itens.every((i) => i.status === 'PULADO' && i.reason === 'campanha cancelada')).toBe(true);
    expect(b.camp[0].skipped_count).toBe(2);
  });

  it('enviar teste manda pro número dado pelo chip do setor, sem mexer na fila', async () => {
    const b = banco();
    const c = await b.svc.criar(T, 'U1', { setor: 'CLINICA', text: 'Oi, {nome}!' });
    await b.svc.testar(T, c.id, '(82) 98888-7777');
    expect(b.enviados[0]).toMatchObject({ tipo: 'texto', para: '82988887777', chip: 'clin', conteudo: 'Oi, Felipe (teste)!' });
    expect(b.itens).toHaveLength(0);
  });
});
