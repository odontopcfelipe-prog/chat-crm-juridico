/**
 * F1 — retrato de EFEITOS "clínica idêntica": o que acontece quando um lead vira
 * paciente (Lead.is_client) — e o espelho, quando volta a ser lead.
 *
 * Congela (jest snapshot, estrito) a sequência de chamadas que cada gatilho faz no
 * banco e nos serviços vizinhos: o claim atômico de is_client/became_client_at, o
 * cancelamento dos follow-ups de LEAD, o stage FINALIZADO (+ histórico, memória da
 * IA, IA religada em POS_VENDA, ficha do paciente, automações), a conversa que
 * troca do setor Comercial pro setor Clínica (inbox + chip) e os avisos de socket.
 *
 * Gatilhos exercitados pelo código REAL de quem dispara:
 *   - pagou no Asaas ........ PaymentGatewayService.promoteLeadFromCharge
 *   - receita paga .......... FinanceiroService.promoteLeadIfPaidReceita
 *   - compareceu na agenda .. CalendarService.autoPromoteFromAttendance
 *   - (os três passam por clinic-transfer-guard: leadIdForCharge, promoteLeadInBackground,
 *     patientEvidence → LeadsService.promoteToPatientIfEligible → promoteLeadCore)
 *   - "Promover a cliente" .. LeadsController.promoteToClient → graduateLeadToClient
 *   - "Mover setor" ......... ConversationsService.moveToSector('CLINICA')
 *   - escreveu no chip Clínica EvolutionService.handleMessagesUpsert (bloco 1a)
 *   - espelho ............... LeadsService.demoteLeadById
 *
 * As fases do laboratório vão dar outros nomes a lead/paciente e setores; o que
 * a CLÍNICA grava e dispara em cada gatilho tem que continuar exatamente isto.
 *
 * Sem banco, sem fila, sem rede: Prisma é um gravador (Proxy) com um "lead" que
 * guarda estado (o claim depende do is_client atual) e os serviços vizinhos são
 * fakes que só anotam a chamada. Relógio fixo; ids são fixos dos fakes.
 * Se a mudança for de propósito para as clínicas:
 * `npx jest src/__guards__/promocao-efeitos -u` em apps/api, commite o .snap junto
 * e explique no commit o que mudou (o diff do .snap mostra a chamada nova/sumida).
 */
import { Logger } from '@nestjs/common';
import { CalendarService } from '../calendar/calendar.service';
import { ConversationsService } from '../conversations/conversations.service';
import { FinanceiroService } from '../financeiro/financeiro.service';
import { FollowupService } from '../followup/followup.service';
import { LeadsController } from '../leads/leads.controller';
import { LeadsService } from '../leads/leads.service';
import { CLINIC_TRANSFER_BLOCKED_MSG } from '../leads/clinic-transfer-guard';
import { PatientsService } from '../patients/patients.service';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';
import { EvolutionService } from '../webhooks/evolution.service';

const AGORA = new Date('2026-10-20T15:00:00.000Z');
const TENANT = 'tenant-clinica-exemplo';
const LEAD = 'lead-1';
const PACIENTE = 'paciente-1';
const TELEFONE = '5582900000001';
const CHIP_CLINICA = { name: 'chip-clinica-exemplo', inbox_id: 'inbox-clinica' };
const CHIP_COMERCIAL = { name: 'chip-comercial-exemplo', inbox_id: 'inbox-comercial' };
// Etapas do funil do lead (a "ganho" é a que o FINALIZADO resolve no dual-write).
const ETAPAS = [
  { id: 'etapa-inicial', slug: 'inicial', name: 'Novo contato', position: 0, is_initial: true, is_won: false, is_lost: false },
  { id: 'etapa-consulta', slug: 'consulta-agendada', name: 'Consulta agendada', position: 2, is_initial: false, is_won: false, is_lost: false },
  { id: 'etapa-orcamento', slug: 'orcamento-enviado', name: 'Orçamento enviado', position: 3, is_initial: false, is_won: false, is_lost: false },
  { id: 'etapa-ganho', slug: 'contrato-assinado', name: 'Contrato assinado', position: 8, is_initial: false, is_won: true, is_lost: false },
  { id: 'etapa-perdido', slug: 'perdido', name: 'Perdido', position: 9, is_initial: false, is_won: false, is_lost: true },
];

type Efeito = [string, ...any[]];

const LEITURAS = new Set(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy']);

/**
 * Prisma falso: grava toda chamada `prisma.<model>.<método>(args)` na lista de
 * efeitos (em ordem, junto com os fakes dos serviços) e responde pelo mapa
 * `respostas` (padrão: findMany → [], updateMany/deleteMany → {count: 1}, resto →
 * null). `$transaction(cb)` roda o callback com um gravador-FILHO, cujas chamadas
 * saem com o prefixo `tx.`, e grava `$transaction:fim` quando o callback termina.
 */
function gravador(efeitos: Efeito[], respostas: Record<string, (args: any) => any>) {
  const cliente = (prefixo: string): any => {
    const modelos: Record<string, any> = {};
    return new Proxy(
      {},
      {
        get(_alvo, modelo: string | symbol) {
          // Não é Promise nem tem símbolos (inspect/toPrimitive).
          if (typeof modelo !== 'string' || modelo === 'then') return undefined;
          if (modelo === '$transaction') {
            return async (cb: any) => {
              efeitos.push([`${prefixo}$transaction`]);
              const r = await cb(cliente(`${prefixo}tx.`));
              efeitos.push([`${prefixo}$transaction:fim`]);
              return r;
            };
          }
          modelos[modelo] ??= new Proxy(
            {},
            {
              get(_m, metodo: string | symbol) {
                if (typeof metodo !== 'string' || metodo === 'then') return undefined;
                return async (args: any) => {
                  const op = `${modelo}.${metodo}`;
                  // F2: ler a lista de laboratórios (cache de 60 s, só leitura) não é
                  // efeito da clínica e fica fora do retrato; qualquer OUTRA operação
                  // em TenantBusinessProfile aparece normalmente.
                  if (op === 'tenantBusinessProfile.findMany') return [];
                  efeitos.push([`${prefixo}${op}`, args]);
                  const r = respostas[op];
                  if (r) return r(args);
                  if (metodo === 'findMany') return [];
                  if (metodo === 'updateMany' || metodo === 'deleteMany') return { count: 1 };
                  return null;
                };
              },
            },
          );
          return modelos[modelo];
        },
      },
    );
  };
  return cliente('prisma.');
}

/** Fake de serviço vizinho: anota `[nome, ...args]` e devolve a resposta. */
function fake(efeitos: Efeito[], nome: string, resposta?: (...a: any[]) => any) {
  return (...args: any[]) => {
    efeitos.push([nome, ...args]);
    return resposta ? resposta(...args) : undefined;
  };
}

interface Cenario {
  /** Já é paciente (is_client) antes do gatilho. */
  is_client: boolean;
  stage: string;
  /** Tem ficha (Patient) vinculada ao lead. */
  temFicha: boolean;
  /** Tem consulta clínica na agenda (qualquer status). */
  agendou: boolean;
  compareceu: boolean;
  /** Cobrança paga no gateway (por paciente ou pelo cliente do Asaas). */
  pagouCobranca: boolean;
  /** Receita PAGA no caixa/Financeiro pro lead. */
  pagouReceita: boolean;
  /** Outro gatilho promoveu no meio do caminho (claim volta count 0). */
  perdeCorrida: boolean;
}

const LEAD_AGENDADO: Cenario = {
  is_client: false,
  stage: 'REUNIAO_AGENDADA',
  temFicha: true,
  agendou: true,
  compareceu: false,
  pagouCobranca: false,
  pagouReceita: false,
  perdeCorrida: false,
};

/**
 * Monta o mundo: banco (gravador com um lead que guarda estado), serviços
 * vizinhos falsos e o LeadsService REAL, registrado no ModuleRef falso (é assim
 * que agenda, gateway e Financeiro o acham em runtime).
 */
function montar(c: Partial<Cenario> = {}, extra: Record<string, (args: any) => any> = {}) {
  const cen: Cenario = { ...LEAD_AGENDADO, ...c };
  const efeitos: Efeito[] = [];
  const lead: Record<string, any> = {
    id: LEAD,
    tenant_id: TENANT,
    name: 'Paciente Exemplo',
    phone: TELEFONE,
    is_client: cen.is_client,
    became_client_at: cen.is_client ? new Date('2026-01-10T12:00:00.000Z') : null,
    stage: cen.stage,
    stage_id: cen.is_client ? 'etapa-ganho' : 'etapa-consulta',
    pipeline_id: 'funil-1',
    cs_user_id: null,
  };

  const respostas: Record<string, (args: any) => any> = {
    // ── Lead (com estado) ──
    'lead.findUnique': (a) => (a.where.id === LEAD ? { ...lead } : null),
    'lead.updateMany': (a) => {
      // Claim atômico: where { id, is_client: false }.
      if (a.where.id !== LEAD || cen.perdeCorrida) return { count: 0 };
      if ('is_client' in a.where && a.where.is_client !== lead.is_client) return { count: 0 };
      Object.assign(lead, a.data);
      return { count: 1 };
    },
    'lead.update': (a) => {
      Object.assign(lead, a.data);
      return { ...lead };
    },
    // ── Paciente / evidências (clinic-transfer-guard.patientEvidence) ──
    'patient.findUnique': (a) =>
      a.where.id === PACIENTE && cen.temFicha ? { id: PACIENTE, tenant_id: TENANT, lead_id: LEAD } : null,
    'patient.findMany': () => (cen.temFicha ? [{ id: PACIENTE }] : []),
    'calendarEvent.findFirst': (a) => {
      if (a.where.status) return cen.compareceu ? { id: 'evento-1' } : null;
      return cen.agendou || cen.compareceu ? { id: 'evento-1' } : null;
    },
    'paymentGatewayCustomer.findMany': () => (cen.pagouCobranca ? [{ external_id: 'cus_exemplo_1' }] : []),
    'paymentGatewayCharge.findFirst': () => (cen.pagouCobranca ? { id: 'cobranca-1' } : null),
    'installment.findFirst': () => null,
    'financialTransaction.findFirst': () => (cen.pagouReceita ? { id: 'receita-1' } : null),
    // leadIdForCharge (gateway): a cobrança paga é do paciente do lead.
    'paymentGatewayCharge.findUnique': () => ({
      customer_external_id: 'cus_exemplo_1',
      patient: { lead_id: LEAD },
      treatment_plan: null,
      installment: null,
    }),
    // CalendarService.autoPromoteFromAttendance: a consulta marcada como Compareceu.
    'calendarEvent.findUnique': () => ({
      lead_id: LEAD,
      patient_id: PACIENTE,
      tenant_id: TENANT,
      type: 'CONSULTA',
      status: 'COMPARECEU',
    }),
    // ── Follow-ups de LEAD em andamento ──
    'followupEnrollment.findMany': () => [{ id: 'inscricao-lead-1' }, { id: 'inscricao-lead-2' }],
    // ── Funil ──
    'pipelineStage.findFirst': (a) => {
      if (a.where.is_won) return ETAPAS.find((e) => e.is_won) ?? null;
      if (a.where.is_lost) return ETAPAS.find((e) => e.is_lost) ?? null;
      return ETAPAS.find((e) => e.slug === a.where.slug) ?? null;
    },
    'pipelineStage.findUnique': (a) => ETAPAS.find((e) => e.id === a.where.id) ?? null,
    'pipelineStage.findMany': () => ETAPAS.map((e) => ({ ...e, pipeline_id: 'funil-1' })),
    // ── Conversas e chips ──
    'instance.findFirst': (a) =>
      a.where.purpose === 'CLINICA' ? { ...CHIP_CLINICA } : a.where.purpose === 'COMERCIAL' ? { ...CHIP_COMERCIAL } : null,
    'conversation.findFirst': (a) => {
      // Gate do FINALIZADO (updateStatus): a conversa tem especialidade.
      if (a.select?.specialty) return { specialty: 'Implante', assigned_dentist_id: null };
      // Quem fechou a venda vira o CS.
      if (a.select?.assigned_user_id) return { assigned_user_id: 'atendente-comercial-1' };
      // Já há conversa ativa no setor de destino? Não.
      if (a.where.inbox_id) return null;
      // A conversa ativa do setor de origem.
      if (a.where.inbox?.purpose) return { id: 'conversa-1' };
      return null;
    },
    'conversation.findUnique': () => ({
      id: 'conversa-1',
      tenant_id: TENANT,
      lead_id: LEAD,
      lead: {
        is_client: lead.is_client,
        became_client_at: lead.became_client_at,
        stage: lead.stage,
        pipeline_id: lead.pipeline_id,
        stage_id: lead.stage_id,
      },
    }),
    'conversation.update': (a) => ({ id: a.where.id, ...a.data }),
    // ── Memória da IA (sem memória ainda: cria) ──
    'aiMemory.findUnique': () => null,
    ...extra,
  };

  const prisma = gravador(efeitos, respostas);
  const chatGateway: any = {
    emitConversationsUpdate: fake(efeitos, 'socket.emitConversationsUpdate'),
    emitNewLeadNotification: fake(efeitos, 'socket.emitNewLeadNotification', async () => undefined),
    emitCalendarUpdate: fake(efeitos, 'socket.emitCalendarUpdate'),
  };
  const automations: any = {
    onStageChange: fake(efeitos, 'automations.onStageChange', async () => undefined),
    onNewLead: fake(efeitos, 'automations.onNewLead', async () => undefined),
  };
  const drive: any = {
    isConfigured: fake(efeitos, 'drive.isConfigured', async () => false),
    ensureLeadFolder: fake(efeitos, 'drive.ensureLeadFolder', async () => null),
  };
  const patients: any = { convertFromLead: fake(efeitos, 'patients.convertFromLead', async () => ({ id: PACIENTE })) };
  const followup: any = { autoEnrollByStage: fake(efeitos, 'followup.autoEnrollByStage', async () => undefined) };

  // ModuleRef falso: só resolve as classes que o código pede (strict:false).
  const registro = new Map<any, any>();
  const moduleRef: any = { get: (cls: any) => registro.get(cls) };
  const leads = new LeadsService(prisma, chatGateway, automations, moduleRef, drive);
  registro.set(LeadsService, leads);
  registro.set(PatientsService, patients);
  registro.set(FollowupService, followup);

  return { cen, lead, efeitos, prisma, chatGateway, moduleRef, leads };
}

/** Deixa terminar o que os gatilhos soltam em segundo plano (.then/.catch sem await). */
async function drenar() {
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res));
}

const ehEscrita = (e: Efeito) => {
  const m = /^prisma\.(?:tx\.)?\w+\.(\w+)$/.exec(e[0]);
  return !m || !LEITURAS.has(m[1]);
};
/** Escritas no banco + chamadas a serviços vizinhos (sem as leituras). */
const escritas = (efeitos: Efeito[]) => efeitos.filter(ehEscrita);
const ops = (efeitos: Efeito[]) => efeitos.map((e) => e[0]);
/**
 * O que vai pro snapshot: escritas e chamadas a vizinhos com os argumentos;
 * leituras só pelo nome (marcam a ordem e as condições conferidas). Os filtros
 * das leituras da regra "compareceu ou pagou" ficam inteiros num retrato à parte.
 */
const retrato = (efeitos: Efeito[]) => efeitos.map((e) => (ehEscrita(e) ? e : e[0]));
const args = (efeitos: Efeito[], op: string) => efeitos.filter((e) => e[0] === op).map((e) => e[1]);
/** Do claim atômico em diante: o núcleo comum (promoteLeadCore). */
const nucleo = (efeitos: Efeito[]) => efeitos.slice(efeitos.findIndex((e) => e[0] === 'prisma.lead.updateMany'));

/** O que toda promoção completa tem que gravar (além do retrato). */
function confereNucleo(efeitos: Efeito[], csUser?: string) {
  const [claim] = args(efeitos, 'prisma.lead.updateMany');
  expect(claim).toEqual({
    where: { id: LEAD, is_client: false },
    data: { is_client: true, became_client_at: AGORA, ...(csUser ? { cs_user_id: csUser } : {}) },
  });
  const finaliza = args(efeitos, 'prisma.lead.update').find((a) => a.data.stage === 'FINALIZADO');
  expect(finaliza?.data).toMatchObject({ stage: 'FINALIZADO', stage_id: 'etapa-ganho', is_client: true });
  expect(args(efeitos, 'prisma.conversation.updateMany')).toContainEqual({
    where: { lead_id: LEAD },
    data: { ai_mode: true, ai_mode_source: 'POS_VENDA', ai_mode_disabled_at: null },
  });
  expect(args(efeitos, 'prisma.conversation.update')).toEqual([
    {
      where: { id: 'conversa-1' },
      data: { inbox_id: CHIP_CLINICA.inbox_id, instance_name: CHIP_CLINICA.name, assigned_user_id: null },
    },
  ]);
}

describe('retrato: efeitos da promoção lead → paciente (F1)', () => {
  let avisos: string[];

  beforeEach(() => {
    // Só o relógio é falso (became_client_at, stage_entered_at, data da memória);
    // setImmediate/setTimeout seguem reais pro drenar().
    jest.useFakeTimers({
      now: AGORA,
      doNotFake: [
        'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
      ],
    });
    // Logs calados; warn/error anotados — erro engolido por best-effort aparece aqui.
    avisos = [];
    for (const nivel of ['log', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
    for (const nivel of ['warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation((m: any) => {
        avisos.push(String(m));
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('gatilhos automáticos (pagou / compareceu)', () => {
    it('pagou no Asaas (PaymentGatewayService.promoteLeadFromCharge): promove, cancela follow-up de lead, FINALIZADO, IA pós-venda, conversa pra Clínica', async () => {
      const m = montar({ pagouCobranca: true });
      const gateway = new PaymentGatewayService(
        m.prisma, {} as any, {} as any, {} as any, m.chatGateway, {} as any, m.moduleRef,
      );
      (gateway as any).promoteLeadFromCharge('cobranca-1', TENANT, 'pagamento confirmado (Asaas)');
      await drenar();

      expect(avisos).toEqual([]);
      confereNucleo(m.efeitos);
      expect(m.lead).toMatchObject({ is_client: true, became_client_at: AGORA, stage: 'FINALIZADO', stage_id: 'etapa-ganho' });
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('compareceu (CalendarService.autoPromoteFromAttendance): mesmo núcleo do pagou', async () => {
      const pago = montar({ pagouCobranca: true });
      const gateway = new PaymentGatewayService(
        pago.prisma, {} as any, {} as any, {} as any, pago.chatGateway, {} as any, pago.moduleRef,
      );
      (gateway as any).promoteLeadFromCharge('cobranca-1', TENANT, 'pagamento confirmado (Asaas)');
      await drenar();

      const m = montar({ compareceu: true });
      const fila: any = { add: fake(m.efeitos, 'fila.calendar-reminders.add'), getJob: async () => null };
      const agenda = new CalendarService(m.prisma, m.chatGateway, fila, {} as any, {} as any, {} as any, m.moduleRef);
      await (agenda as any).autoPromoteFromAttendance('evento-1');
      await drenar();

      expect(avisos).toEqual([]);
      confereNucleo(m.efeitos);
      // Do claim em diante é a MESMA sequência do pagamento (a fonte só vai pro log).
      expect(nucleo(m.efeitos)).toEqual(nucleo(pago.efeitos));
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('receita paga no Financeiro, contato SEM ficha (FinanceiroService.promoteLeadIfPaidReceita): promove e cria a ficha', async () => {
      const m = montar({ temFicha: false, agendou: false, pagouReceita: true });
      const fin = new FinanceiroService(m.prisma, m.moduleRef);
      (fin as any).promoteLeadIfPaidReceita(
        { type: 'RECEITA', status: 'PAGO', lead_id: LEAD, tenant_id: TENANT },
        'receita paga (Financeiro)',
      );
      await drenar();

      expect(avisos).toEqual([]);
      confereNucleo(m.efeitos);
      expect(args(m.efeitos, 'prisma.financialTransaction.findFirst')).toEqual([
        { where: { lead_id: LEAD, type: 'RECEITA', status: 'PAGO' }, select: { id: true } },
      ]);
      expect(m.efeitos.filter((e) => e[0] === 'patients.convertFromLead')).toEqual([['patients.convertFromLead', LEAD, TENANT]]);
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('agendou mas não compareceu nem pagou: segue LEAD — só leituras, nada gravado', async () => {
      const m = montar();
      const r = await m.leads.promoteToPatientIfEligible(LEAD, TENANT, 'aprovar e cobrar (orçamento orcamento-1)', 'operador-1');
      await drenar();

      expect(r).toEqual({ ok: false, leadId: LEAD, notYet: true });
      expect(avisos).toEqual([]);
      expect(escritas(m.efeitos)).toEqual([]);
      expect(m.lead.is_client).toBe(false);
      // Aqui as leituras vão INTEIRAS: é o retrato do que conta como "compareceu"
      // (tipos clínicos + status) e "pagou" (cobrança, parcela, receita no caixa).
      expect(m.efeitos).toMatchSnapshot('leituras da regra compareceu-ou-pagou, com filtros');
    });

    it('já é paciente: idempotente — uma leitura e mais nada', async () => {
      const m = montar({ is_client: true, stage: 'FINALIZADO', pagouCobranca: true });
      const r = await m.leads.promoteToPatientIfEligible(LEAD, TENANT, 'pagamento confirmado (Asaas)');
      await drenar();

      expect(r).toEqual({ ok: true, leadId: LEAD, alreadyClient: true });
      expect(ops(m.efeitos)).toEqual(['prisma.lead.findUnique']);
    });

    it('dois gatilhos juntos (PIX CONFIRMED + RECEIVED): quem perde o claim para no claim', async () => {
      const m = montar({ pagouCobranca: true, perdeCorrida: true });
      const r = await m.leads.promoteToPatientIfEligible(LEAD, TENANT, 'pagamento confirmado (Asaas)');
      await drenar();

      expect(r).toEqual({ ok: true, leadId: LEAD });
      expect(escritas(m.efeitos).map((e) => e[0])).toEqual(['prisma.lead.updateMany']);
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });
  });

  describe('ações manuais', () => {
    it('"Promover a cliente" (LeadsController.promoteToClient) de lead nunca agendado: garante a ficha, promove e grava o operador como CS', async () => {
      const m = montar({ agendou: false });
      const controller = new LeadsController(m.leads, {} as any);
      const r = await controller.promoteToClient(LEAD, { user: { id: 'operador-1', tenant_id: TENANT } });
      await drenar();

      expect(r).toEqual({ ok: true, leadId: LEAD, stageFinalized: true, movedConversations: 1 });
      expect(avisos).toEqual([]);
      confereNucleo(m.efeitos, 'operador-1');
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('"Promover a cliente" de lead agendado sem comparecer/pagar: barrado (400) sem gravar nada', async () => {
      const m = montar();
      const controller = new LeadsController(m.leads, {} as any);
      await expect(
        controller.promoteToClient(LEAD, { user: { id: 'operador-1', tenant_id: TENANT } }),
      ).rejects.toThrow(CLINIC_TRANSFER_BLOCKED_MSG);
      await drenar();

      // Só a garantia da ficha (convertFromLead é idempotente) — nenhuma escrita no banco.
      expect(escritas(m.efeitos)).toEqual([['patients.convertFromLead', LEAD, TENANT]]);
      expect(m.lead.is_client).toBe(false);
    });

    it('"Mover setor → Clínica" (ConversationsService.moveToSector): troca inbox/chip, IA assume e marca is_client (sem FINALIZADO)', async () => {
      const m = montar({ agendou: false });
      const conversas = new ConversationsService(m.prisma, m.chatGateway, {} as any, {} as any);
      const r: any = await conversas.moveToSector('conversa-1', 'CLINICA', 'operador-1');
      await drenar();

      expect(avisos).toEqual([]);
      expect(r).toMatchObject({ inbox_id: CHIP_CLINICA.inbox_id, instance_name: CHIP_CLINICA.name, ai_mode: true });
      expect(args(m.efeitos, 'prisma.lead.update')).toEqual([
        { where: { id: LEAD }, data: { is_client: true, became_client_at: AGORA } },
      ]);
      expect(m.lead.stage).toBe('REUNIAO_AGENDADA');
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });
  });

  describe('chip Clínica: o contato escreve no número da clínica (webhook)', () => {
    /**
     * EvolutionService.handleMessagesUpsert de verdade, até a busca da conversa
     * (passo 2). Ali o banco falso lança PARADA_DO_RETRATO: conversa, mensagem e
     * IA não são deste retrato — só a classificação lead × paciente (bloco 1a).
     * leads.upsert é fake (devolve o lead do mundo).
     */
    async function webhook(c: Partial<Cenario>, opts: { fromMe?: boolean; chip?: 'CLINICA' | 'COMERCIAL' } = {}) {
      const m = montar(c, {
        'conversation.findFirst': () => {
          throw new Error('PARADA_DO_RETRATO');
        },
      });
      const chip = opts.chip === 'COMERCIAL' ? CHIP_COMERCIAL : CHIP_CLINICA;
      const inboxes: any = {
        findByInstanceName: fake(m.efeitos, 'inboxes.findByInstanceName', async () => ({
          ...chip,
          tenant_id: TENANT,
          purpose: opts.chip ?? 'CLINICA',
          inbox: { id: chip.inbox_id, tenant_id: TENANT },
        })),
      };
      const leadsFake: any = { upsert: fake(m.efeitos, 'leads.upsert', async () => ({ ...m.lead })) };
      const adminBot: any = { isEnabled: fake(m.efeitos, 'adminBot.isEnabled', async () => false) };
      const evo = new EvolutionService(
        m.prisma, m.chatGateway, leadsFake, inboxes, {} as any, {} as any, {} as any, m.moduleRef, adminBot, {} as any, {} as any,
      );
      await expect(
        evo.handleMessagesUpsert({
          event: 'messages.upsert',
          instance: chip.name,
          data: {
            key: { remoteJid: `${TELEFONE}@s.whatsapp.net`, fromMe: !!opts.fromMe, id: 'MSG-EXEMPLO-1' },
            pushName: 'Paciente Exemplo',
            message: { conversation: 'Oi, tudo bem?' },
            messageType: 'conversation',
            messageTimestamp: Math.floor(AGORA.getTime() / 1000),
          },
        }),
      ).rejects.toThrow('PARADA_DO_RETRATO');
      await drenar();
      expect(avisos).toEqual([]);
      return m;
    }

    it('contato nunca agendado escreve no chip Clínica → vira paciente (só is_client/became_client_at)', async () => {
      const m = await webhook({ agendou: false });

      expect(escritas(m.efeitos).filter((e) => e[0].startsWith('prisma.'))).toEqual([
        ['prisma.lead.update', { where: { id: LEAD }, data: { is_client: true, became_client_at: AGORA } }],
      ]);
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('lead agendado sem comparecer/pagar escreve no chip Clínica → segue LEAD', async () => {
      const m = await webhook({});

      expect(escritas(m.efeitos).filter((e) => e[0].startsWith('prisma.'))).toEqual([]);
      expect(m.lead.is_client).toBe(false);
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('eco de mensagem NOSSA saindo pelo chip Clínica (fromMe) → não promove nem consulta a trava', async () => {
      const m = await webhook({ agendou: false }, { fromMe: true });

      expect(escritas(m.efeitos).filter((e) => e[0].startsWith('prisma.'))).toEqual([]);
      expect(ops(m.efeitos)).toEqual(['inboxes.findByInstanceName', 'leads.upsert', 'prisma.conversation.findFirst']);
    });

    it('contato escreve no chip Comercial → continua lead (sem consulta à trava)', async () => {
      const m = await webhook({ agendou: false }, { chip: 'COMERCIAL' });

      expect(escritas(m.efeitos).filter((e) => e[0].startsWith('prisma.'))).toEqual([]);
      expect(ops(m.efeitos)).toEqual([
        'inboxes.findByInstanceName', 'adminBot.isEnabled', 'leads.upsert', 'prisma.conversation.findFirst',
      ]);
    });
  });

  describe('espelho: paciente volta a ser lead', () => {
    it('LeadsService.demoteLeadById: is_client=false, sai do ganho, conversa volta pro Comercial, IA POS_VENDA → COMERCIAL', async () => {
      const m = montar({ is_client: true, stage: 'FINALIZADO' });
      const r = await m.leads.demoteLeadById(LEAD, TENANT);
      await drenar();

      expect(r).toEqual({ ok: true, leadId: LEAD });
      expect(avisos).toEqual([]);
      expect(m.lead).toMatchObject({ is_client: false, became_client_at: null, stage: 'NEGOCIACAO', stage_id: 'etapa-orcamento' });
      expect(args(m.efeitos, 'prisma.conversation.update')).toEqual([
        {
          where: { id: 'conversa-1' },
          data: { inbox_id: CHIP_COMERCIAL.inbox_id, instance_name: CHIP_COMERCIAL.name, assigned_user_id: null },
        },
      ]);
      expect(retrato(m.efeitos)).toMatchSnapshot('efeitos em ordem');
    });
  });
});
