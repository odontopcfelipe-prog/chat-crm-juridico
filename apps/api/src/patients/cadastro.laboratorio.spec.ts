/**
 * F5 do laboratório — cadastro manual do cliente (PatientsService) numa conta de
 * LABORATÓRIO.
 *
 * No laboratório o cliente (dentista ou clínica) nasce do cadastro manual. Então o
 * contato do WhatsApp ligado ao cadastro vira cliente ali mesmo: is_client=true com
 * became_client_at. Vale para o contato criado pelo cadastro, para o contato que já
 * existia com o mesmo número (veio do WhatsApp) e para o cadastro feito a partir de
 * um contato. Só isso: sem troca de setor, sem etapa, sem IA e sem mensagem. Quem já
 * era cliente fica como está. Cada caso registra `[LAB-GATE] cliente-do-cadastro`.
 *
 * Clínica: as MESMAS chamadas, na MESMA ordem e com os MESMOS argumentos sem
 * laboratório cadastrado e com OUTRA conta laboratório (a única coisa nova é a
 * leitura da lista de laboratórios, que fica fora do rastro). O contato da clínica
 * continua nascendo sem is_client.
 *
 * Sem banco: o Prisma é um gravador que guarda o estado do contato; serviços vizinhos
 * são fakes que anotam a chamada no mesmo rastro. Relógio fixo; dados de exemplo.
 */
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { normalizeBrazilianPhone } from '../common/utils/phone';
import { PatientsService } from './patients.service';

const AGORA = new Date('2026-10-28T15:00:00.000Z');
const ANTES = new Date('2026-01-10T12:00:00.000Z');
const CLINICA = 'tenant-clinica-exemplo';
const LAB = 'tenant-lab-exemplo';
const OUTRO_LAB = 'tenant-outro-lab-exemplo';
const CADASTRO = 'cadastro-1';
const CONTATO = 'lead-whatsapp-1';
const TELEFONE = '(82) 9 9000-0002';
const TELEFONE_CANONICO = normalizeBrazilianPhone(TELEFONE);

type Efeito = [string, ...any[]];

let logs: { nivel: string; msg: string }[] = [];
const registrou = (nivel: string, trecho: string) => logs.some((l) => l.nivel === nivel && l.msg.includes(trecho));
const avisos = () => logs.filter((l) => l.nivel === 'warn' || l.nivel === 'error').map((l) => l.msg);

beforeEach(() => {
  logs = [];
  __limparCacheLabTenants();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push({ nivel, msg: String(msg) });
    });
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

interface Cenario {
  /** Conta de quem cadastra. */
  conta: string;
  /** Contas de laboratório cadastradas. */
  labs: string[];
  /** Já existe contato com o número (veio do WhatsApp). */
  contato: null | { is_client: boolean; name: string };
  /** O contato já pertence a OUTRO cadastro (família divide o número). */
  deOutroCadastro: boolean;
}

/** Banco gravador + PatientsService REAL com vizinhos falsos, num rastro só. */
function montar(c: Partial<Cenario> = {}) {
  const cen: Cenario = { conta: CLINICA, labs: [], contato: null, deOutroCadastro: false, ...c };
  __limparCacheLabTenants();
  const efeitos: Efeito[] = [];
  const contatos: Record<string, any> = {};
  if (cen.contato) {
    contatos[CONTATO] = {
      id: CONTATO,
      tenant_id: cen.conta,
      name: cen.contato.name,
      phone: TELEFONE_CANONICO,
      stage: 'NOVO',
      is_client: cen.contato.is_client,
      became_client_at: cen.contato.is_client ? ANTES : null,
    };
  }
  const cadastro: Record<string, any> = { id: CADASTRO, tenant_id: cen.conta, name: 'Dra. Ana Exemplo', phone: TELEFONE, lead_id: null };
  const casa = (l: any, w: any) =>
    (w.id === undefined || l.id === w.id) &&
    (w.tenant_id === undefined || l.tenant_id === w.tenant_id) &&
    (w.is_client === undefined || l.is_client === w.is_client);
  const respostas: Record<string, (a: any) => any> = {
    'tenant.findUnique': () => ({ plan: null }),
    'patient.count': () => 0,
    'patient.create': (a) => {
      Object.assign(cadastro, a.data);
      return { ...cadastro };
    },
    'patient.findUnique': (a) => (a.where.id === CADASTRO ? { ...cadastro } : null),
    'patient.findFirst': (a) => (cen.deOutroCadastro && a.where.lead_id === CONTATO ? { id: 'cadastro-da-familia' } : null),
    'patient.update': (a) => {
      Object.assign(cadastro, a.data);
      return { ...cadastro };
    },
    'lead.findUnique': (a) => (contatos[a.where.id] ? { ...contatos[a.where.id] } : null),
    'lead.findFirst': (a) => {
      const l = Object.values(contatos).find(
        (x) => x.tenant_id === a.where.tenant_id && a.where.phone.in.includes(x.phone),
      );
      return l ? { id: l.id, name: l.name } : null;
    },
    'lead.update': (a) => {
      Object.assign(contatos[a.where.id], a.data);
      return { ...contatos[a.where.id] };
    },
    'lead.updateMany': (a) => {
      const alvo = Object.values(contatos).filter((l) => casa(l, a.where));
      alvo.forEach((l) => Object.assign(l, a.data));
      return { count: alvo.length };
    },
    'lead.create': (a) => {
      const l = { id: 'lead-do-cadastro', is_client: false, became_client_at: null, ...a.data };
      contatos[l.id] = l;
      return { id: l.id, name: l.name };
    },
  };
  const perfis = jest.fn(async () => cen.labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        // A lista de laboratórios (cache de 60 s) fica fora do rastro.
        if (modelo === 'tenantBusinessProfile') return { findMany: perfis };
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                efeitos.push([`prisma.${op}`, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany') return [];
                if (metodo === 'updateMany' || metodo === 'deleteMany') return { count: 0 };
                return null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );
  const fake = (nome: string, resposta?: (...a: any[]) => any) => (...a: any[]) => {
    efeitos.push([nome, ...a]);
    return resposta ? resposta(...a) : undefined;
  };
  const conversations: any = {
    findOrCreatePatientConversationId: fake('conversations.findOrCreatePatientConversationId', async () => 'conversa-1'),
  };
  const whatsapp: any = new Proxy({}, { get: (_w, m: string | symbol) => (typeof m === 'string' && m !== 'then' ? fake(`whatsapp.${m}`) : undefined) });
  const referrals: any = { createPending: fake('referrals.createPending', async () => null) };
  const tags: any = { setTagsForPatient: fake('tags.setTagsForPatient', async () => undefined) };
  const svc = new PatientsService(prisma, {} as any, referrals, tags, whatsapp, conversations);
  const de = (op: string) => efeitos.filter((e) => e[0] === op).map((e) => e[1]);
  const nomes = () => efeitos.map((e) => e[0]);
  return { cen, contatos, cadastro, efeitos, de, nomes, svc, perfis };
}

/** Nada do que a clínica faz ao virar paciente: setor, conversa, IA, etapa, mensagem, cadastro automático. */
function nadaDeClinica(m: ReturnType<typeof montar>) {
  const nomes = m.nomes();
  expect(nomes.filter((n) => n.startsWith('whatsapp.'))).toEqual([]);
  expect(nomes.filter((n) => /^prisma\.(conversation|aiMemory|instance|inbox|leadStageHistory|followupEnrollment)\./.test(n))).toEqual([]);
  expect(m.de('prisma.lead.update').filter((a: any) => 'stage' in a.data || 'stage_id' in a.data || 'is_client' in a.data)).toEqual([]);
  expect(m.de('prisma.lead.updateMany').filter((a: any) => Object.keys(a.data).some((k) => k !== 'is_client' && k !== 'became_client_at'))).toEqual([]);
}

/** Roda o mesmo cenário de clínica sem laboratório e com OUTRA conta laboratório. */
async function clinicaIgual(c: Partial<Cenario>, rodar: (m: ReturnType<typeof montar>) => Promise<unknown>) {
  const sem = montar({ ...c, conta: CLINICA, labs: [] });
  const rSem = await rodar(sem).catch((e) => e);
  const com = montar({ ...c, conta: CLINICA, labs: [OUTRO_LAB] });
  const rCom = await rodar(com).catch((e) => e);
  expect(com.efeitos).toEqual(sem.efeitos);
  expect(rCom).toEqual(rSem);
  expect(com.contatos).toEqual(sem.contatos);
  expect(registrou('log', '[LAB-GATE]')).toBe(false);
  return { sem, com, r: rSem };
}

const NOVO_CADASTRO = { name: 'Dra. Ana Exemplo', phone: TELEFONE } as any;
const CONTATO_DO_CADASTRO_CLINICA = {
  name: 'Dra. Ana Exemplo',
  phone: TELEFONE_CANONICO,
  tenant_id: CLINICA,
  stage: 'NOVO',
  origin: 'cadastro_manual',
};

describe('cadastro manual — número sem contato (o cadastro cria o contato)', () => {
  it('laboratório: o contato já nasce cliente (is_client + became_client_at), sem nada de clínica', async () => {
    const m = montar({ conta: LAB, labs: [LAB] });
    await m.svc.create(LAB, NOVO_CADASTRO);

    expect(m.de('prisma.lead.create')).toEqual([
      {
        data: { ...CONTATO_DO_CADASTRO_CLINICA, tenant_id: LAB, is_client: true, became_client_at: AGORA },
        select: { id: true, name: true },
      },
    ]);
    expect(m.contatos['lead-do-cadastro']).toMatchObject({ is_client: true, became_client_at: AGORA, stage: 'NOVO' });
    expect(m.cadastro.lead_id).toBe('lead-do-cadastro');
    // A conversa do cadastro é garantida como sempre (sem trocar de setor).
    expect(m.de('conversations.findOrCreatePatientConversationId')).toEqual(['lead-do-cadastro']);
    expect(m.de('prisma.lead.updateMany')).toEqual([]);
    nadaDeClinica(m);
    expect(registrou('log', '[LAB-GATE] cliente-do-cadastro')).toBe(true);
    expect(avisos()).toEqual([]);
  });

  it('clínica sem laboratório e com OUTRA conta laboratório: mesmas chamadas, contato nasce sem is_client', async () => {
    const { sem } = await clinicaIgual({}, (m) => m.svc.create(CLINICA, NOVO_CADASTRO));
    expect(sem.de('prisma.lead.create')).toEqual([{ data: CONTATO_DO_CADASTRO_CLINICA, select: { id: true, name: true } }]);
    expect(Object.keys(sem.de('prisma.lead.create')[0].data)).toEqual(['name', 'phone', 'tenant_id', 'stage', 'origin']);
    expect(sem.contatos['lead-do-cadastro'].is_client).toBe(false);
    expect(sem.nomes()).toEqual([
      'prisma.tenant.findUnique',
      'prisma.patient.count',
      'prisma.patient.create',
      'prisma.lead.findFirst',
      'prisma.lead.create',
      'prisma.patient.update',
      'conversations.findOrCreatePatientConversationId',
    ]);
  });
});

describe('cadastro manual — o número já tem contato (veio do WhatsApp)', () => {
  it('laboratório: o contato vira cliente, a etapa fica como está e o nome do cadastro é adotado', async () => {
    const m = montar({ conta: LAB, labs: [LAB], contato: { is_client: false, name: 'Ana (WhatsApp)' } });
    await m.svc.create(LAB, NOVO_CADASTRO);

    expect(m.de('prisma.lead.updateMany')).toEqual([
      { where: { id: CONTATO, tenant_id: LAB, is_client: false }, data: { is_client: true, became_client_at: AGORA } },
    ]);
    expect(m.contatos[CONTATO]).toMatchObject({ is_client: true, became_client_at: AGORA, stage: 'NOVO', name: 'Dra. Ana Exemplo' });
    expect(m.de('prisma.lead.create')).toEqual([]);
    expect(m.cadastro.lead_id).toBe(CONTATO);
    expect(m.de('conversations.findOrCreatePatientConversationId')).toEqual([CONTATO]);
    nadaDeClinica(m);
    expect(registrou('log', '[LAB-GATE] cliente-do-cadastro')).toBe(true);
    expect(avisos()).toEqual([]);
  });

  it('laboratório: contato que já era cliente fica como está (a data de entrada não muda)', async () => {
    const m = montar({ conta: LAB, labs: [LAB], contato: { is_client: true, name: 'Dra. Ana Exemplo' } });
    await m.svc.create(LAB, NOVO_CADASTRO);

    expect(m.contatos[CONTATO]).toMatchObject({ is_client: true, became_client_at: ANTES });
    expect(m.de('prisma.lead.create')).toEqual([]);
    nadaDeClinica(m);
  });

  it('laboratório: número de OUTRO cadastro (família) — não vincula e não marca nada', async () => {
    const m = montar({ conta: LAB, labs: [LAB], contato: { is_client: false, name: 'Ana (WhatsApp)' }, deOutroCadastro: true });
    await m.svc.create(LAB, NOVO_CADASTRO);

    expect(m.contatos[CONTATO]).toMatchObject({ is_client: false, became_client_at: null });
    expect(m.de('prisma.lead.updateMany')).toEqual([]);
    expect(m.de('prisma.patient.update')).toEqual([]);
    expect(m.de('conversations.findOrCreatePatientConversationId')).toEqual([]);
  });

  it('clínica sem laboratório e com OUTRA conta laboratório: mesmas chamadas, contato segue lead', async () => {
    const { sem } = await clinicaIgual({ contato: { is_client: false, name: 'Ana (WhatsApp)' } }, (m) =>
      m.svc.create(CLINICA, NOVO_CADASTRO),
    );
    expect(sem.contatos[CONTATO]).toMatchObject({ is_client: false, became_client_at: null, name: 'Dra. Ana Exemplo' });
    expect(sem.nomes()).toEqual([
      'prisma.tenant.findUnique',
      'prisma.patient.count',
      'prisma.patient.create',
      'prisma.lead.findFirst',
      'prisma.patient.findFirst',
      'prisma.lead.update',
      'prisma.patient.update',
      'conversations.findOrCreatePatientConversationId',
    ]);
    expect(sem.de('prisma.lead.update')).toEqual([{ where: { id: CONTATO }, data: { name: 'Dra. Ana Exemplo' } }]);
  });
});

describe('cadastro feito a partir de um contato (lead_id no corpo)', () => {
  it('laboratório: o contato escolhido vira cliente, sem procurar outro pelo número', async () => {
    const m = montar({ conta: LAB, labs: [LAB], contato: { is_client: false, name: 'Ana (WhatsApp)' } });
    await m.svc.create(LAB, { ...NOVO_CADASTRO, lead_id: CONTATO });

    expect(m.de('prisma.lead.updateMany')).toEqual([
      { where: { id: CONTATO, tenant_id: LAB, is_client: false }, data: { is_client: true, became_client_at: AGORA } },
    ]);
    expect(m.contatos[CONTATO]).toMatchObject({ is_client: true, became_client_at: AGORA, stage: 'NOVO' });
    expect(m.de('prisma.lead.findFirst')).toEqual([]);
    expect(m.de('prisma.lead.create')).toEqual([]);
    nadaDeClinica(m);
    expect(registrou('log', '[LAB-GATE] cliente-do-cadastro')).toBe(true);
  });

  it('clínica sem laboratório e com OUTRA conta laboratório: só o cadastro é gravado, como antes', async () => {
    const { sem } = await clinicaIgual({ contato: { is_client: false, name: 'Ana (WhatsApp)' } }, (m) =>
      m.svc.create(CLINICA, { ...NOVO_CADASTRO, lead_id: CONTATO }),
    );
    expect(sem.nomes()).toEqual([
      'prisma.tenant.findUnique',
      'prisma.patient.count',
      'prisma.lead.findUnique',
      'prisma.patient.create',
    ]);
    expect(sem.contatos[CONTATO].is_client).toBe(false);
  });
});

describe('reparo "garantir conversa" do cadastro (ensure-conversation)', () => {
  it('laboratório: liga o contato ao cadastro e marca cliente', async () => {
    const m = montar({ conta: LAB, labs: [LAB], contato: { is_client: false, name: 'Dra. Ana Exemplo' } });
    await m.svc.ensureLeadAndConversationPublic(CADASTRO, LAB);

    expect(m.cadastro.lead_id).toBe(CONTATO);
    expect(m.contatos[CONTATO]).toMatchObject({ is_client: true, became_client_at: AGORA });
    nadaDeClinica(m);
  });

  it('clínica sem laboratório e com OUTRA conta laboratório: mesmas chamadas, contato segue lead', async () => {
    const { sem } = await clinicaIgual({ contato: { is_client: false, name: 'Dra. Ana Exemplo' } }, (m) =>
      m.svc.ensureLeadAndConversationPublic(CADASTRO, CLINICA),
    );
    expect(sem.contatos[CONTATO].is_client).toBe(false);
    expect(sem.de('prisma.lead.updateMany')).toEqual([]);
  });
});
