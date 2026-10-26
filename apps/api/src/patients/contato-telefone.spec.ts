/**
 * Trocar o telefone no cadastro leva o contato do WhatsApp (Lead) junto.
 *
 * Caso real: o paciente seguia ligado ao contato com o número velho (sem WhatsApp)
 * e toda mensagem saía "não enviada"; o WhatsApp de verdade dele estava noutro
 * contato, solto. Banco falso em memória, com as duas travas que importam: telefone
 * único por clínica e uma conversa ativa por contato e setor.
 *
 * Repositório público: ids e números fictícios.
 */
import { Logger } from '@nestjs/common';
import { levarContatoParaTelefoneNovo, mesmoNumero } from './contato-telefone';
import { PatientsService } from './patients.service';

const T = 'clinica-exemplo';
const VELHO = '558290000001'; // número velho do contato (sem WhatsApp)
const VELHO_CADASTRO = '(82) 9000-0001';
const NOVO_CADASTRO = '(82) 9 9000-0002'; // como a tela grava
const NOVO = '558290000002'; // forma canônica (55 + DDD + 8)

type Lead = {
  id: string; tenant_id: string; phone: string; name: string; email?: string | null; profile_picture_url?: string | null;
  is_client: boolean; became_client_at?: Date | null; tags: string[];
  whatsapp_invalid_at?: Date | null; contact_opt_out_at?: Date | null; contact_opt_out_reason?: string | null;
  non_patient_category?: string | null; non_patient_at?: Date | null;
};
type Conv = { id: string; lead_id: string; inbox_id: string | null; status: string; last_message_at: Date; ai_mode: boolean; external_id?: string | null };
type Pac = { id: string; lead_id: string | null; phone: string | null; tenant_id: string; name?: string };

const BLOQUEIOS = ['contractSignature', 'paymentGatewayCustomer', 'leadHonorario', 'financialTransaction', 'calendarEvent', 'notaFiscal', 'leadNote', 'waitlistEntry', 'leadProfile'];

function banco(ini: { leads: Lead[]; patients: Pac[]; convs?: Conv[]; msgs?: { id: string; conversation_id: string }[]; bloqueios?: Record<string, string[]>; aiMemory?: string[] }) {
  const leads = ini.leads.map((l) => ({ ...l }));
  const patients = ini.patients.map((p) => ({ ...p }));
  const convs = (ini.convs ?? []).map((c) => ({ ...c }));
  const msgs = (ini.msgs ?? []).map((m) => ({ ...m }));
  const aiMemory = [...(ini.aiMemory ?? [])]; // lead_id de quem tem
  const escritas: string[] = [];

  const casaId = (id: string, w: any) => w === undefined || (typeof w === 'string' ? id === w : id !== w.not);
  const casaLead = (l: Lead, w: any) =>
    casaId(l.id, w.id) && (w.tenant_id === undefined || l.tenant_id === w.tenant_id) && (w.phone === undefined || w.phone.in.includes(l.phone));
  const conferirTelefoneUnico = () => {
    const vistos = new Set<string>();
    for (const l of leads) {
      const k = `${l.tenant_id}|${l.phone}`;
      if (vistos.has(k)) throw Object.assign(new Error('Unique constraint (tenant_id, phone)'), { code: 'P2002' });
      vistos.add(k);
    }
  };
  const conferirConversaUnica = () => {
    const vistos = new Set<string>();
    for (const c of convs) {
      if (c.status === 'ENCERRADO' || !c.inbox_id) continue;
      const k = `${c.lead_id}|${c.inbox_id}`;
      if (vistos.has(k)) throw Object.assign(new Error('Conversation_lead_inbox_active_uq'), { code: 'P2002' });
      vistos.add(k);
    }
  };

  const prisma: any = {
    lead: {
      findFirst: jest.fn(async ({ where }: any) => leads.find((l) => casaLead(l, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => leads.filter((l) => casaLead(l, where))),
      findUnique: jest.fn(async ({ where }: any) => leads.find((l) => l.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const l = leads.find((x) => x.id === where.id)!;
        Object.assign(l, data);
        escritas.push(`lead.update ${where.id} ${Object.keys(data).join(',')}`);
        conferirTelefoneUnico();
        return l;
      }),
      delete: jest.fn(async ({ where }: any) => {
        leads.splice(leads.findIndex((x) => x.id === where.id), 1);
        escritas.push(`lead.delete ${where.id}`);
      }),
    },
    patient: {
      findFirst: jest.fn(async ({ where }: any) =>
        patients.find((p) => p.tenant_id === where.tenant_id && where.lead_id.in.includes(p.lead_id) && p.id !== where.id.not) ?? null),
      findUnique: jest.fn(async ({ where }: any) => patients.find((p) => p.id === where.id) ?? null),
      count: jest.fn(async ({ where }: any) => patients.filter((p) => p.lead_id === where.lead_id).length),
      update: jest.fn(async ({ where, data }: any) => {
        const p = patients.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        return { ...p };
      }),
    },
    conversation: {
      findMany: jest.fn(async ({ where }: any) =>
        convs.filter((c) => where.lead_id.in.includes(c.lead_id) && c.inbox_id && c.status !== 'ENCERRADO')),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(convs.find((c) => c.id === where.id)!, data);
        escritas.push(`conversation.update ${where.id} ${Object.keys(data).join(',')}`);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        convs
          .filter((c) => c.lead_id === where.lead_id && (!where.external_id || where.external_id.in.includes(c.external_id)))
          .forEach((c) => Object.assign(c, data));
        conferirConversaUnica();
      }),
    },
    message: {
      count: jest.fn(async ({ where }: any) => msgs.filter((m) => m.conversation_id === where.conversation_id).length),
      updateMany: jest.fn(async ({ where, data }: any) => {
        msgs.filter((m) => m.conversation_id === where.conversation_id).forEach((m) => Object.assign(m, data));
      }),
    },
    aiMemory: {
      findUnique: jest.fn(async ({ where }: any) => (aiMemory.includes(where.lead_id) ? { lead_id: where.lead_id } : null)),
      update: jest.fn(async ({ where, data }: any) => { aiMemory[aiMemory.indexOf(where.lead_id)] = data.lead_id; }),
      delete: jest.fn(async ({ where }: any) => { aiMemory.splice(aiMemory.indexOf(where.lead_id), 1); }),
      deleteMany: jest.fn(async ({ where }: any) => { if (aiMemory.includes(where.lead_id)) aiMemory.splice(aiMemory.indexOf(where.lead_id), 1); }),
    },
    task: { updateMany: jest.fn(async () => ({ count: 0 })) },
    followupEnrollment: { findMany: jest.fn(async () => []) },
    followupMessage: { updateMany: jest.fn(async () => ({ count: 0 })) },
    broadcastItem: { updateMany: jest.fn(async () => ({ count: 0 })) },
    leadReactivation: { updateMany: jest.fn(async () => ({ count: 0 })) },
    leadDispatch: { updateMany: jest.fn(async () => ({ count: 0 })) },
    memory: { updateMany: jest.fn(async () => ({ count: 0 })) },
    $transaction: jest.fn(async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma))),
  };
  for (const t of BLOQUEIOS) {
    prisma[t] = { count: jest.fn(async ({ where }: any) => (ini.bloqueios?.[t] ?? []).filter((id) => id === where.lead_id).length) };
  }
  return { prisma, leads, patients, convs, msgs, aiMemory, escritas };
}

const logger = { log: jest.fn(), warn: jest.fn() };
const lead = (id: string, phone: string, extra: Partial<Lead> = {}): Lead => ({ id, tenant_id: T, phone, name: id, is_client: false, tags: [], ...extra });
const pac = (extra: Partial<Pac> = {}): Pac => ({ id: 'pac-1', lead_id: 'lead-paciente', phone: NOVO_CADASTRO, tenant_id: T, ...extra });
const args = { tenantId: T, patientId: 'pac-1', leadId: 'lead-paciente', telefoneAntes: VELHO_CADASTRO, telefone: NOVO_CADASTRO };

beforeEach(() => jest.clearAllMocks());

describe('mesmoNumero', () => {
  it('com/sem o 9 e com/sem o 55 é o mesmo; outro final é outro', () => {
    expect(mesmoNumero('5582990000002', '(82) 9000-0002')).toBe(true);
    expect(mesmoNumero('558290000002', '82990000002')).toBe(true);
    expect(mesmoNumero('558290000001', '558290000002')).toBe(false);
    expect(mesmoNumero(null, '558290000002')).toBe(false);
  });
});

describe('levarContatoParaTelefoneNovo', () => {
  it('ninguém tem o número novo → o contato passa a usá-lo, sem a marca "sem WhatsApp" do velho, e o tique de lida vai pro novo', async () => {
    const db = banco({
      leads: [lead('lead-paciente', VELHO, { whatsapp_invalid_at: new Date('2026-10-01') })],
      patients: [pac()],
      convs: [{ id: 'c1', lead_id: 'lead-paciente', inbox_id: 's1', status: 'ABERTO', last_message_at: new Date(), ai_mode: true, external_id: `${VELHO}@s.whatsapp.net` }],
    });
    await expect(levarContatoParaTelefoneNovo(db.prisma, args, logger)).resolves.toBe('atualizado');
    expect(db.leads[0]).toMatchObject({ phone: NOVO, whatsapp_invalid_at: null });
    expect(db.convs[0].external_id).toBe(`${NOVO}@s.whatsapp.net`);
  });

  it('telefone que não é BR válido (máscara que cortou o número) → não mexe', async () => {
    const db = banco({ leads: [lead('lead-paciente', VELHO)], patients: [pac()] });
    await expect(levarContatoParaTelefoneNovo(db.prisma, { ...args, telefone: '55829000000' }, logger)).resolves.toBeNull();
    expect(db.escritas).toEqual([]);
    expect(db.leads[0].phone).toBe(VELHO);
  });

  it('contato que não seguia o número antigo do cadastro (ex.: WhatsApp do responsável) → não mexe', async () => {
    const db = banco({ leads: [lead('lead-paciente', '558290000099')], patients: [pac()] });
    await expect(levarContatoParaTelefoneNovo(db.prisma, args, logger)).resolves.toBeNull();
    expect(db.escritas).toEqual([]);
  });

  it('contato já está no número novo (só muda o 9) → nada', async () => {
    const db = banco({ leads: [lead('lead-paciente', NOVO)], patients: [] });
    await expect(levarContatoParaTelefoneNovo(db.prisma, { ...args, telefoneAntes: NOVO }, logger)).resolves.toBeNull();
    expect(db.escritas).toEqual([]);
  });

  it('contato de outra clínica com o mesmo id não é tocado', async () => {
    const db = banco({ leads: [{ ...lead('lead-paciente', VELHO), tenant_id: 'outra-clinica' }], patients: [] });
    await expect(levarContatoParaTelefoneNovo(db.prisma, args, logger)).resolves.toBeNull();
    expect(db.escritas).toEqual([]);
  });

  it('o número novo é o contato de OUTRO paciente (família) → não mexe e avisa', async () => {
    const db = banco({
      leads: [lead('lead-paciente', VELHO), lead('lead-mae', NOVO)],
      patients: [pac(), pac({ id: 'pac-mae', lead_id: 'lead-mae', phone: NOVO })],
    });
    await expect(levarContatoParaTelefoneNovo(db.prisma, args, logger)).resolves.toBe('numero_de_outro_paciente');
    expect(db.escritas).toEqual([]);
  });

  it('gêmeos do número novo (12 e 13 dígitos), um deles de outro paciente → não mexe (confere todos)', async () => {
    const db = banco({
      leads: [lead('lead-paciente', VELHO), lead('lead-solto', NOVO), lead('lead-mae', '5582990000002')],
      patients: [pac(), pac({ id: 'pac-mae', lead_id: 'lead-mae', phone: NOVO })],
    });
    await expect(levarContatoParaTelefoneNovo(db.prisma, args, logger)).resolves.toBe('numero_de_outro_paciente');
    expect(db.escritas).toEqual([]);
  });

  it('gêmeos soltos do número novo → pede revisão (não junta dois de uma vez)', async () => {
    const db = banco({ leads: [lead('lead-paciente', VELHO), lead('lead-a', NOVO), lead('lead-b', '5582990000002')], patients: [pac()] });
    await expect(levarContatoParaTelefoneNovo(db.prisma, args, logger)).resolves.toBe('revisar');
    expect(db.escritas).toEqual([]);
  });

  it('o outro contato tem dado de negócio (agenda) → não junta e pede revisão', async () => {
    const db = banco({
      leads: [lead('lead-paciente', VELHO), lead('lead-whats', NOVO)],
      patients: [pac()],
      bloqueios: { calendarEvent: ['lead-whats'] },
    });
    await expect(levarContatoParaTelefoneNovo(db.prisma, args, logger)).resolves.toBe('revisar');
    expect(db.escritas).toEqual([]);
    expect(db.leads.map((l) => l.phone)).toEqual([VELHO, NOVO]);
  });

  it('o WhatsApp real está noutro contato sem dado → vira um só, com as conversas e o número novo', async () => {
    const optOut = new Date('2026-10-10');
    const db = banco({
      leads: [
        lead('lead-paciente', VELHO, { is_client: true, whatsapp_invalid_at: new Date('2026-10-01') }),
        lead('lead-whats', NOVO, {
          tags: ['instagram'], contact_opt_out_at: optOut, contact_opt_out_reason: 'pediu', whatsapp_invalid_at: null,
          non_patient_category: 'OUTRO', non_patient_at: new Date('2026-10-25'),
        }),
      ],
      patients: [pac()],
      convs: [
        // conversa do contato velho: só as tentativas que falharam
        { id: 'conv-velha', lead_id: 'lead-paciente', inbox_id: 'setor-clinica', status: 'ABERTO', last_message_at: new Date('2026-10-26T14:11:00Z'), ai_mode: true, external_id: `${VELHO}@s.whatsapp.net` },
        // conversa de verdade, no mesmo setor
        { id: 'conv-real', lead_id: 'lead-whats', inbox_id: 'setor-clinica', status: 'ABERTO', last_message_at: new Date('2026-10-20T12:00:00Z'), ai_mode: true, external_id: `${NOVO}@s.whatsapp.net` },
        // conversa do Financeiro: setor diferente, só muda de contato
        { id: 'conv-fin', lead_id: 'lead-whats', inbox_id: 'setor-financeiro', status: 'ABERTO', last_message_at: new Date('2026-10-21T12:00:00Z'), ai_mode: false, external_id: `${NOVO}@s.whatsapp.net` },
      ],
      msgs: [
        { id: 'e1', conversation_id: 'conv-velha' }, { id: 'e2', conversation_id: 'conv-velha' },
        { id: 'r1', conversation_id: 'conv-real' }, { id: 'r2', conversation_id: 'conv-real' }, { id: 'r3', conversation_id: 'conv-real' },
      ],
      aiMemory: ['lead-paciente', 'lead-whats'],
    });

    await expect(levarContatoParaTelefoneNovo(db.prisma, args, logger)).resolves.toBe('unido');

    // Fica o contato do paciente, no número novo, com a marca "sem WhatsApp" do número
    // novo (nenhuma) e o "pediu pra parar" do outro; o outro some.
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0]).toMatchObject({
      id: 'lead-paciente', phone: NOVO, is_client: true, tags: ['instagram'], whatsapp_invalid_at: null,
      contact_opt_out_at: optOut, contact_opt_out_reason: 'pediu',
    });
    // "Não é paciente" do outro não passa pro contato que tem ficha de paciente.
    expect(db.leads[0].non_patient_category).toBeUndefined();
    // Fica a conversa com mais mensagens (e a hora da última); a outra é encerrada e as mensagens vêm junto.
    const conv = (id: string) => db.convs.find((c) => c.id === id)!;
    expect(conv('conv-real')).toMatchObject({ lead_id: 'lead-paciente', status: 'ABERTO', last_message_at: new Date('2026-10-26T14:11:00Z') });
    expect(conv('conv-velha')).toMatchObject({ status: 'ENCERRADO', ai_mode: false, external_id: `${NOVO}@s.whatsapp.net` });
    expect(db.msgs.every((m) => m.conversation_id === 'conv-real')).toBe(true);
    expect(conv('conv-fin')).toMatchObject({ lead_id: 'lead-paciente', status: 'ABERTO' });
    // Memória da IA: fica a da conversa de verdade (era do outro), movida pro contato do paciente.
    expect(db.aiMemory).toEqual(['lead-paciente']);
    expect(db.prisma.aiMemory.deleteMany).toHaveBeenCalledWith({ where: { lead_id: 'lead-paciente' } });
    expect(db.prisma.aiMemory.update).toHaveBeenCalledWith({ where: { lead_id: 'lead-whats' }, data: { lead_id: 'lead-paciente' } });
    expect(db.prisma.memory.updateMany).toHaveBeenCalledWith({ where: { scope: 'lead', scope_id: 'lead-whats' }, data: { scope_id: 'lead-paciente' } });
    // Régua de reativação: ciclo ativo do outro encerrado e o histórico vem junto.
    expect(db.prisma.leadReactivation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lead_id: 'lead-whats', status: 'ATIVA' }, data: expect.objectContaining({ status: 'CANCELADA' }) }),
    );
    const movido = { where: { lead_id: 'lead-whats' }, data: { lead_id: 'lead-paciente' } };
    expect(db.prisma.leadReactivation.updateMany).toHaveBeenCalledWith(movido);
    expect(db.prisma.leadDispatch.updateMany).toHaveBeenCalledWith(movido);
    // O outro contato é apagado ANTES de o número passar (telefone único por clínica).
    expect(db.escritas.indexOf('lead.delete lead-whats')).toBeLessThan(db.escritas.indexOf('lead.update lead-paciente phone,whatsapp_invalid_at'));
  });
});

describe('PatientsService.update: telefone trocado leva o contato', () => {
  function servico(ini: Parameters<typeof banco>[0]) {
    const db = banco(ini);
    const svc = new PatientsService(db.prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, db };
  }
  const base = () => ({ leads: [lead('lead-paciente', VELHO)], patients: [pac({ phone: VELHO_CADASTRO, name: 'Paciente' })] });
  const EDICAO = { levarContatoWhatsapp: true };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('edição do cadastro com telefone novo → contato atualizado e a resposta diz isso', async () => {
    const { svc, db } = servico(base());
    const r: any = await svc.update('pac-1', T, { phone: NOVO_CADASTRO }, EDICAO);
    expect(r.whatsapp_contato).toBe('atualizado');
    expect(db.leads[0].phone).toBe(NOVO);
  });

  it('outros caminhos (ex.: consulta de crédito, sem opts) → contato não muda', async () => {
    const { svc, db } = servico(base());
    const r: any = await svc.update('pac-1', T, { phone: NOVO_CADASTRO });
    expect(r.whatsapp_contato).toBeUndefined();
    expect(db.leads[0].phone).toBe(VELHO);
  });

  it('mesmo número com outra máscara (com o 9) → contato não muda', async () => {
    const { svc, db } = servico(base());
    const r: any = await svc.update('pac-1', T, { phone: '(82) 9 9000-0001' }, EDICAO);
    expect(r.whatsapp_contato).toBeUndefined();
    expect(db.leads[0].phone).toBe(VELHO);
  });

  it('salvar sem mexer no telefone → contato não muda (mesmo se ele estiver diferente do cadastro)', async () => {
    const ini = base();
    ini.patients[0].phone = NOVO_CADASTRO; // cadastro já diferente do contato
    const { svc, db } = servico(ini);
    const r: any = await svc.update('pac-1', T, { name: 'Paciente', phone: NOVO_CADASTRO }, EDICAO);
    expect(r.whatsapp_contato).toBeUndefined();
    expect(db.leads[0].phone).toBe(VELHO);
  });

  it('falha técnica ao levar o contato não derruba o salvamento → "erro"', async () => {
    const { svc, db } = servico(base());
    db.prisma.lead.update.mockRejectedValueOnce(new Error('banco fora'));
    const r: any = await svc.update('pac-1', T, { phone: NOVO_CADASTRO }, EDICAO);
    expect(r).toMatchObject({ phone: NOVO_CADASTRO, whatsapp_contato: 'erro' });
  });
});
