/**
 * F1 — retrato de comportamento "clínica idêntica": as MENSAGENS que o paciente recebe.
 *
 * Congela (jest snapshot, estrito) todo texto PADRÃO ou FIXO que a clínica manda
 * pro paciente/lead por WhatsApp ou e-mail, já renderizado com variáveis de
 * exemplo: confirmação e lembretes da agenda, aniversário, retorno de manutenção,
 * negociação/apresentação/entrada/comprovante/PIX do fechamento, orçamento, TCLE,
 * confirmação/estorno/reenvio de cobrança, entrega dos boletos, pesquisa
 * pós-atendimento e os e-mails automáticos. As fases do laboratório vão trocar palavras ("paciente",
 * "consulta", "clínica") num caminho NOVO; o caminho da clínica tem que continuar
 * mandando exatamente isto — vírgula, emoji e quebra de linha.
 *
 * Fiel ao código: cada snapshot sai do método REAL que monta o texto (services
 * com Prisma, WhatsApp, e-mail e Asaas mockados — sem banco, sem rede), ou da
 * função real do @crm/shared que a produção usa pra renderizar. Nada de cópia
 * dos textos aqui. Relógio fixo (terça 20/10/2026, 12:00 em Maceió).
 *
 * Métodos que fazem `await import('@crm/shared')` não rodam no jest deste projeto
 * (sem --experimental-vm-modules). Esses services (CalendarService, o worker de
 * lembretes, PaymentGatewayService, BoletoDeliveryService) são carregados por
 * `carregarFonte`: o MESMO arquivo-fonte, transpilado em CommonJS — o import
 * dinâmico vira require, o resto é o código de produção byte a byte.
 *
 * Datas formatadas com toLocaleDateString (sem timeZone) usam horário de meio
 * do dia nos exemplos, pra sair igual em UTC (CI/produção) e em America/Sao_Paulo.
 *
 * Se a mudança for de propósito para as clínicas: `npx jest __guards__/mensagens-paciente -u`
 * em apps/api e commite o .snap junto, explicando no commit o que o paciente passa a receber.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';
import * as ts from 'typescript';
import {
  COMERCIAL_AGENDA_IDS,
  COBRANCA_STAGES,
  COBRANCA_TIPOS,
  DEFAULT_AUDIO_TESTE,
  DEFAULT_BIRTHDAY_GREETING,
  DEFAULT_COBRANCA_TEMPLATES,
  DEFAULT_COMERCIAL_AGENDA,
  DEFAULT_CONFIRMACAO_ORTO,
  DEFAULT_ORTO_IMMEDIATE,
  DEFAULT_ORTO_REMINDER,
  DEFAULT_RECALL_TEMPLATE,
  DEFAULT_REMINDER_CONFIG,
  REATIVACAO_COLUNAS,
  REATIVACAO_GANCHO_GENERICO,
  REATIVACAO_GANCHOS,
  RETORNO_DISPARO_IDS,
  applyTemplate,
  buildCondicoesBlock,
  comercialLembreteIdFor,
  confirmacaoMetodoLabel,
  defaultCobrancaTemplate,
  defaultFinTemplate,
  defaultReativacaoModelo,
  dentistaDoModelo,
  instrucaoVoz,
  interesseDoFunil,
  parseRetornoDisparoId,
  pickTemplateKey,
  receivedMethodLabel,
  removerFrasesComVariavelVazia,
  renderReativacaoModelo,
  stripInternalTags,
  textoParaFala,
  valoresPorProcedimento,
} from '@crm/shared';
import { RetornoDisparosService } from '../agenda-extended/retorno-disparos.service';
import { QuotesService } from '../commercial/quotes.service';
import { TreatmentPlanContractService } from '../commercial/treatment-plan-contract.service';
import { MailService } from '../common/mail/mail.service';
import { EmailAutomationService } from '../email-automation/email-automation.service';
import { EMAIL_EVENTS } from '../email-automation/email-events';
import {
  DEFAULT_CONFIG as POS_ATENDIMENTO_PADRAO,
  renderApology,
  renderInitialMessage,
  renderThanks,
} from '../post-care/post-care-templates';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const TENANT = 'tenant-clinica-exemplo';
const CLINICA = 'Clínica Exemplo';
const AGORA = new Date('2026-10-20T15:00:00.000Z'); // terça, 12:00 em Maceió
const TEL = '5582900000001';
const EMAIL_PACIENTE = 'paciente@exemplo.test';
const EMAIL_CLINICA = 'contato@clinica-exemplo.test';
const PACIENTE = 'Maria Exemplo da Silva';
const DENTISTA = 'Dra. Ana Exemplo Souza';
const ENDERECO = {
  address: 'Rua Exemplo',
  address_number: '100',
  address_complement: 'Sala 2',
  neighborhood: 'Centro',
  city: 'Maceió',
  state: 'AL',
};
// Consulta na quinta 22/10/2026 às 14:30 de Maceió — gravada nos campos UTC (naive).
const CONSULTA = new Date('2026-10-22T14:30:00.000Z');
const PIX_EXEMPLO = '000201EXEMPLO-PIX-COPIA-E-COLA';

// ─── Carregador: o arquivo-fonte real, com o import dinâmico virando require ─
const RAIZ_SRC = path.resolve(__dirname, '..');
const OPCOES_TS = (() => {
  const raizApi = path.resolve(RAIZ_SRC, '..');
  const lido = ts.readConfigFile(path.join(raizApi, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.convertCompilerOptionsFromJson(lido.config.compilerOptions, raizApi);
  return {
    ...options,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    resolvePackageJsonExports: undefined,
    sourceMap: false,
    inlineSourceMap: false,
    declaration: false,
    incremental: false,
  };
})();

function carregarFonte(relativo: string): any {
  const arquivo = path.join(RAIZ_SRC, relativo);
  const { outputText } = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), {
    fileName: arquivo,
    compilerOptions: OPCOES_TS,
  });
  const modulo = { exports: {} as any };
  const requerer = (id: string) =>
    require(id.startsWith('.') ? path.resolve(path.dirname(arquivo), id) : id);
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    modulo.exports, requerer, modulo, arquivo, path.dirname(arquivo),
  );
  return modulo.exports;
}

const { CalendarService } = carregarFonte('calendar/calendar.service.ts');
const { CalendarReminderWorker } = carregarFonte('calendar/calendar-reminder.worker.ts');
const { PaymentGatewayService } = carregarFonte('payment-gateway/payment-gateway.service.ts');
const { BoletoDeliveryService } = carregarFonte('payment-gateway/boleto-delivery.service.ts');

// ─── Mocks ───────────────────────────────────────────────────────────────────

/**
 * Prisma falso: grava `prisma.<model>.<método>(args)` e responde pelo mapa
 * `respostas` (padrão: null). `$transaction(cb)` roda o callback com o mesmo
 * gravador. Os retratos daqui olham o TEXTO enviado; o banco só alimenta.
 */
function gravador(respostas: Record<string, (args: any) => any> = {}) {
  const chamadas: { op: string; args: any }[] = [];
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_alvo, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === '$transaction') return async (cb: any) => (typeof cb === 'function' ? cb(prisma) : Promise.all(cb));
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                chamadas.push({ op, args });
                const r = respostas[op];
                return r ? r(args) : null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );
  const de = (op: string) => chamadas.filter((c) => c.op === op).map((c) => c.args);
  return { prisma, chamadas, de };
}

/** Banco de uma clínica de exemplo. `settings` = GlobalSetting por chave. */
function banco(extra: Record<string, (args: any) => any> = {}, settings: Record<string, string> = {}) {
  return {
    'globalSetting.findUnique': (a: any) => (a.where.key in settings ? { value: settings[a.where.key] } : null),
    'tenantSetting.findUnique': () => null,
    'tenant.findUnique': () => ({ name: CLINICA, email: EMAIL_CLINICA, ...ENDERECO }),
    'instance.findFirst': (a: any) => ({ name: `chip-${String(a?.where?.purpose ?? 'clinica').toLowerCase()}` }),
    'instance.findMany': () => [
      { name: 'chip-comercial', purpose: 'COMERCIAL' },
      { name: 'chip-clinica', purpose: 'CLINICA' },
      { name: 'chip-financeiro', purpose: 'FINANCEIRO' },
    ],
    'conversation.findFirst': () => ({ id: 'conv-1', instance_name: 'chip-clinica' }),
    'disparoAnexo.findMany': () => [],
    'patient.findUnique': () => ({ name: PACIENTE, phone: TEL, email: EMAIL_PACIENTE }),
    'auditLog.findFirst': () => null,
    'auditLog.create': () => ({ id: 'audit-1' }),
    'auditLog.count': () => 0,
    'tenantEmailTemplate.findUnique': () => null,
    ...extra,
  };
}

/** WhatsApp falso: grava cada envio como o paciente veria (texto/legenda + anexo). */
function zap() {
  const envios: any[] = [];
  let n = 0;
  const ok = () => {
    n++;
    return { key: { id: `wamid-${n}` }, data: { key: { id: `wamid-${n}` } } };
  };
  const whatsapp: any = {
    getInstanceForPurpose: async (_t: string, p: string) => `chip-${p.toLowerCase()}`,
    sendText: async (para: string, texto: string, chip?: string) => {
      envios.push({ via: 'sendText', para, chip: chip ?? null, texto });
      return ok();
    },
    sendMedia: async (para: string, tipo: string, midia: string, legenda?: string, chip?: string, arquivo?: string, mime?: string) => {
      envios.push({
        via: 'sendMedia',
        para,
        chip: chip ?? null,
        tipo,
        arquivo: arquivo ?? null,
        mime: mime ?? null,
        midia: /^https?:\/\//.test(String(midia)) ? midia : '<arquivo em base64>',
        legenda: legenda ?? null,
      });
      return ok();
    },
  };
  return { whatsapp, envios };
}

/** MessagesService/ConversationsService falsos (envio pela conversa de PACIENTE). */
function conversaPaciente() {
  const envios: any[] = [];
  const enviado = { message: { id: 'msg-1', external_message_id: 'wamid-1' }, instance: 'chip-clinica', purpose: 'CLINICA' };
  const messages: any = {
    resolvePatientChips: async () => [{ name: 'chip-clinica', purpose: 'CLINICA' }],
    assertPatientSendable: async () => undefined,
    sendPatientText: async (o: any) => {
      envios.push({ via: 'sendPatientText', conversa: o.conversationId, para: o.expectedPhone ?? null, texto: o.text });
      return enviado;
    },
    sendPatientFile: async (o: any) => {
      envios.push({
        via: 'sendPatientFile',
        conversa: o.conversationId,
        para: o.expectedPhone ?? null,
        arquivo: o.file.originalname,
        mime: o.file.mimetype,
        legenda: o.caption,
      });
      return enviado;
    },
  };
  const conversations: any = { findOrCreatePatientConversationId: async () => 'conv-paciente-1' };
  return { messages, conversations, envios };
}

/** MailService REAL (template visual de verdade), só o SMTP é falso. */
function correio(prisma: any) {
  const enviados: any[] = [];
  const mail = new MailService(prisma, {} as any);
  jest.spyOn(mail, 'send').mockImplementation(async (c: any) => {
    enviados.push({ para: c.to, de: c.fromName ?? null, responderPara: c.replyTo ?? null, assunto: c.subject, html: c.html });
    return true;
  });
  return { mail, enviados };
}

beforeEach(() => {
  // Só o relógio é falso; promessas, streams (pdfkit) e timers seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// packages/shared — textos-padrão e as funções de render que a produção usa
// ═════════════════════════════════════════════════════════════════════════════

describe('retrato: textos-padrão do @crm/shared (F1)', () => {
  const VARS_AGENDA = {
    nome: 'Maria',
    nome_completo: PACIENTE,
    dentista: 'Dra. Ana',
    dentista_completo: DENTISTA,
    data: 'qui 22/10/2026',
    hora: '14:30',
    local: 'Rua Exemplo, 100 — Sala 2, Centro, Maceió/AL',
    clinica: CLINICA,
    antecedencia: '1 dia',
  };

  it('packages/shared/src/reminder-config.ts — confirmação, lembretes, ortodontia, recall e aniversário', () => {
    const { local: _semLocal, ...varsSemLocal } = VARS_AGENDA;
    const render = (tpl: string) => ({ com_local: applyTemplate(tpl, VARS_AGENDA), sem_local: applyTemplate(tpl, varsSemLocal) });
    const t = DEFAULT_REMINDER_CONFIG.templates;
    expect({
      liga_desliga_padrao: DEFAULT_REMINDER_CONFIG.enabled,
      antecedencias_padrao: DEFAULT_REMINDER_CONFIG.default_antecedencias,
      // Faixa de antecedência → qual template sai (a de 48h é forçada pra consulta_confirmacao).
      faixa_do_template: Object.fromEntries([2880, 1440, 600, 60, 59, 15].map((m) => [m, pickTemplateKey(m)])),
      consulta_confirmacao: render(t.consulta_confirmacao),
      consulta_24h: render(t.consulta_24h),
      consulta_1h: render(t.consulta_1h),
      consulta_15min: render(t.consulta_15min),
      confirmacao_ortodontia: render(DEFAULT_CONFIRMACAO_ORTO),
      lembrete_ortodontia_portoes: render(DEFAULT_ORTO_REMINDER),
      ortodontia_imediata: render(DEFAULT_ORTO_IMMEDIATE),
      // Recall de revisão: o worker troca {nome} {procedimento} {data} (retrato do worker).
      recall_cru: DEFAULT_RECALL_TEMPLATE,
      // Aniversário: só {nome} e {clinica} (render real no CalendarService, abaixo).
      aniversario_crus: {
        msg1: { ligada: DEFAULT_BIRTHDAY_GREETING.enabled, hora: DEFAULT_BIRTHDAY_GREETING.send_at, texto: DEFAULT_BIRTHDAY_GREETING.template },
        msg2: { ligada: DEFAULT_BIRTHDAY_GREETING.message2_enabled, hora: DEFAULT_BIRTHDAY_GREETING.message2_send_at, texto: DEFAULT_BIRTHDAY_GREETING.message2_template },
        msg3: { ligada: DEFAULT_BIRTHDAY_GREETING.message3_enabled, hora: DEFAULT_BIRTHDAY_GREETING.message3_send_at, texto: DEFAULT_BIRTHDAY_GREETING.message3_template },
      },
    }).toMatchSnapshot();
  });

  it('packages/shared/src/cobranca.ts — régua por estágio × tipo, textos da venda e blocos montados', () => {
    // Régua: o texto padrão de cada estágio para cada tipo (o worker preenche {nome}
    // {valor} {data} {codigo}; retrato do render no worker).
    const regua = Object.fromEntries(
      COBRANCA_STAGES.map((s) => [s, Object.fromEntries(COBRANCA_TIPOS.map((tp) => [tp, defaultCobrancaTemplate(s, tp)]))]),
    );
    // Sem tipo = 'parcelado' (o editor e a cron caem nele).
    for (const s of COBRANCA_STAGES) expect(defaultFinTemplate(s)).toBe(defaultCobrancaTemplate(s, 'parcelado'));
    expect(regua).toMatchSnapshot('régua: estágio × tipo');
    expect(DEFAULT_COBRANCA_TEMPLATES).toMatchSnapshot('régua: texto único legado (pré-split por tipo)');
    expect(
      Object.fromEntries(
        ['confirmacao_pagamento', 'boleto_intro', 'boleto_delivery', 'negociacao_aprovada', 'negociacao_aprovada_avista', 'pix_delivery', 'comprovante_pagamento']
          .map((id) => [id, defaultFinTemplate(id)]),
      ),
    ).toMatchSnapshot('textos da venda e do pagamento (crus)');
    expect({
      parcelado_com_entrada: buildCondicoesBlock({ entrada: 500, parcelas: 10, valorParcela: 250, total: 3000 }),
      entrada_e_1_parcela: buildCondicoesBlock({ entrada: 500, parcelas: 1, valorParcela: 1000, total: 1500 }),
      so_parcelas: buildCondicoesBlock({ parcelas: 6, valorParcela: 200, total: 1200 }),
      a_vista_pix: buildCondicoesBlock({ total: 1500, formaLabel: 'PIX' }),
      a_vista_sem_forma: buildCondicoesBlock({ total: 1500 }),
      metodo_da_confirmacao: Object.fromEntries(['PIX', 'BOLETO', 'CREDIT_CARD', 'UNDEFINED'].map((b) => [b, confirmacaoMetodoLabel(b)])),
      forma_recebida: Object.fromEntries(
        ['DINHEIRO', 'CASH', 'CARTAO', 'CREDIT_CARD', 'PIX_MAQUININHA', 'PIX', 'BOLETO', 'OUTRA'].map((m) => [m, receivedMethodLabel(m)]),
      ),
      descricao_sem_tag_interna: stripInternalTags('Parcela 3/10 — Maria Exemplo [plan:00000000-0000-0000-0000-0000000000aa]'),
    }).toMatchSnapshot('blocos montados (condições, método, forma, descrição)');
  });

  it('packages/shared/src/comercial-agenda.ts — agenda do lead (crus) e a faixa de cada lembrete', () => {
    // Render real: CalendarService (confirmação/reagendamento) e o worker de lembretes (abaixo).
    expect({
      ids: COMERCIAL_AGENDA_IDS,
      faixa_do_lembrete: Object.fromEntries([2880, 1440, 60, 15].map((m) => [m, comercialLembreteIdFor(m)])),
      textos: DEFAULT_COMERCIAL_AGENDA,
    }).toMatchSnapshot();
  });

  it('packages/shared/src/reativacao-leads.ts — modelos dos toques por coluna (com e sem tabela de valores)', () => {
    // Prévia determinística / fallback sem IA: tira a frase do preço que a clínica não
    // liberou e preenche as variáveis (a IA do worker reescreve a partir DESTE modelo).
    const tabela = 'Avaliação: R$ 150\nLimpeza completa: R$ 250\nClareamento: R$ 800 (a avaliação define)';
    const comValores = valoresPorProcedimento(tabela, true);
    const semValores = valoresPorProcedimento(tabela, false);
    const vars = (valores: Record<string, string>, gancho: string) => ({
      nome: 'Maria',
      interesse: interesseDoFunil('Implantes'),
      assunto: 'o dente que está faltando',
      gancho,
      horario1: 'quinta (22/10) às 14:30',
      horario2: 'sexta (23/10) às 9:00',
      data: '19/10',
      hora: '15:00',
      clinica: CLINICA,
      dentista: dentistaDoModelo(DENTISTA),
      ...valores,
    });
    const modelo = (txt: string, v: Record<string, string>) => renderReativacaoModelo(removerFrasesComVariavelVazia(txt, v), v);
    const ganchoImplantes = REATIVACAO_GANCHOS.implantes;
    const porColuna = (valores: Record<string, string>) =>
      Object.fromEntries(
        REATIVACAO_COLUNAS.map((col) => {
          const toques: string[] = [];
          for (let i = 1; defaultReativacaoModelo(col, i); i++) {
            toques.push(modelo(defaultReativacaoModelo(col, i), vars(valores, ganchoImplantes)));
          }
          return [col, toques];
        }),
      );
    expect({
      valores_da_tabela: { com: comValores, sem: semValores },
      dentista_do_modelo: {
        dra: dentistaDoModelo(DENTISTA),
        dr: dentistaDoModelo('Dr. Paulo Exemplo'),
        sem_nome: dentistaDoModelo(''),
      },
      ganchos_por_funil: Object.fromEntries(
        Object.entries(REATIVACAO_GANCHOS).map(([funil, g]) => [funil, modelo(g, vars(comValores, ''))]),
      ),
      gancho_generico: REATIVACAO_GANCHO_GENERICO,
      com_valores_liberados: porColuna(comValores),
      sem_valores_liberados: porColuna(semValores),
    }).toMatchSnapshot();
  });

  it('packages/shared/src/audio-disparo.ts — lembrete em áudio (teste): texto falado e instrução da voz', () => {
    // Só sai pro número que a clínica digita no teste (não vai sozinho pro paciente).
    expect({
      config_padrao: DEFAULT_AUDIO_TESTE,
      texto_falado: textoParaFala(DEFAULT_AUDIO_TESTE.texto, {
        nome: 'Maria', clinica: CLINICA, data: '22/10', hora: '14:30', dentista: 'Dra. Ana',
      }),
      instrucao_da_voz: instrucaoVoz(DEFAULT_AUDIO_TESTE),
    }).toMatchSnapshot();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Agenda — calendar.service.ts e calendar-reminder.worker.ts
// ═════════════════════════════════════════════════════════════════════════════

describe('retrato: agenda → paciente (F1)', () => {
  function agenda(settings: Record<string, string> = {}, extra: Record<string, (a: any) => any> = {}) {
    const g = gravador(banco(extra, settings));
    const z = zap();
    const c = correio(g.prisma);
    const email = new EmailAutomationService(g.prisma, c.mail);
    const svc = new CalendarService(g.prisma, {} as any, {} as any, {} as any, z.whatsapp, email, {} as any);
    return { svc, g, z, c };
  }

  function evento(over: Record<string, any> = {}) {
    return {
      id: 'ev-1',
      type: 'CONSULTA',
      title: 'Avaliação',
      start_at: CONSULTA,
      location: null,
      assigned_user: { name: DENTISTA },
      lead: { id: 'lead-1', name: PACIENTE, phone: TEL, is_client: true },
      ...over,
    };
  }

  it('apps/api/src/calendar/calendar.service.ts — sendAppointmentEventWhatsapp (agendada, remarcada, ortodontia, lead)', async () => {
    const casos: Record<string, any> = {};
    const rodar = async (nome: string, ev: any, kind: 'created' | 'rescheduled', settings: Record<string, string> = {}, extra = {}) => {
      const { svc, z } = agenda(settings, extra);
      const r = await svc.sendAppointmentEventWhatsapp(ev, 'pac-1', 'lead-1', TENANT, kind);
      expect([nome, r]).toEqual([nome, { sent: true }]);
      casos[nome] = z.envios;
    };

    await rodar('consulta agendada — paciente (texto fixo)', evento(), 'created');
    await rodar(
      'consulta agendada — sem dentista e sem endereço cadastrado',
      evento({ assigned_user: null }),
      'created',
      {},
      { 'tenant.findUnique': () => ({ name: CLINICA }) },
    );
    await rodar('consulta agendada — local digitado no evento', evento({ location: 'Unidade Centro — 2º andar' }), 'created');
    await rodar('consulta remarcada — texto padrão', evento(), 'rescheduled');
    await rodar('ortodontia por hora marcada (padrão) — mesmo texto da consulta', evento({ type: 'ORTODONTIA' }), 'created');
    await rodar(
      'ortodontia por ordem de chegada — confirmação imediata',
      evento({ type: 'ORTODONTIA' }),
      'created',
      { [`ORTO_ORDEM_CHEGADA_${TENANT}`]: 'true' },
    );
    await rodar(
      'lead (não-cliente) — agenda do Comercial: avaliação agendada',
      evento({ lead: { id: 'lead-1', name: PACIENTE, phone: TEL, is_client: false } }),
      'created',
      { [`COMERCIAL_AGENDA_ENABLED_comercial_confirmacao_${TENANT}`]: 'true' },
    );
    await rodar(
      'lead (não-cliente) — agenda do Comercial: avaliação remarcada',
      evento({ lead: { id: 'lead-1', name: PACIENTE, phone: TEL, is_client: false } }),
      'rescheduled',
      { [`COMERCIAL_AGENDA_ENABLED_comercial_reagendamento_${TENANT}`]: 'true' },
    );
    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/calendar/calendar.service.ts — textos-padrão servidos à Central (confirmação 24h, remarcada, ortodontia)', async () => {
    const { svc } = agenda();
    expect({
      confirmacao_24h: (await svc.getAppointmentConfirmationConfig(TENANT)).template,
      remarcada: (await svc.getAppointmentRescheduledConfig(TENANT)).template,
      confirmacao_ortodontia: (await svc.getAppointmentConfirmationOrtoConfig(TENANT)).template,
      lembrete_ortodontia: (await svc.getAppointmentOrtoReminderConfig(TENANT)).template,
      ortodontia_imediata: (await svc.getAppointmentOrtoImmediateConfig(TENANT)).template,
      lembretes: (await svc.getReminderConfig(TENANT)).templates,
    }).toMatchSnapshot();
  });

  it('apps/api/src/calendar/calendar.service.ts — sendBirthdayGreetingsNow (as 3 mensagens de aniversário)', async () => {
    const casos: Record<string, any> = {};
    for (const qual of [1, 2, 3] as const) {
      const { svc, z } = agenda({}, {
        // Aniversariante de hoje (20/10, dia de Maceió).
        'patient.findMany': () => [{ id: 'pac-1', name: PACIENTE, phone: TEL, birth_date: new Date('1990-10-20T00:00:00.000Z') }],
      });
      const r = await svc.sendBirthdayGreetingsNow(TENANT, qual);
      expect(r.total).toBe(1);
      casos[`mensagem ${qual}`] = z.envios;
    }
    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/calendar/calendar.service.ts — sendAppointmentEventEmail (e-mail de consulta agendada/remarcada)', async () => {
    const { svc, c } = agenda();
    await (svc as any).sendAppointmentEventEmail(evento(), 'pac-1', null, TENANT, 'agendamento_criado');
    await (svc as any).sendAppointmentEventEmail(evento(), 'pac-1', null, TENANT, 'agendamento_remarcado');
    expect(c.enviados).toHaveLength(2);
    expect(c.enviados).toMatchSnapshot();
  });

  describe('apps/api/src/calendar/calendar-reminder.worker.ts', () => {
    function lembretes(settings: Record<string, string> = {}) {
      const g = gravador(banco({}, settings));
      const z = zap();
      const appSettings: any = { getAiConfig: async () => { throw new Error('sem IA no retrato'); } };
      return { worker: new CalendarReminderWorker(g.prisma, z.whatsapp, appSettings), z };
    }
    function eventoLembrete(over: Record<string, any> = {}) {
      return {
        id: 'ev-1',
        type: 'CONSULTA',
        status: 'AGENDADO',
        tenant_id: TENANT,
        title: 'Avaliação',
        start_at: CONSULTA,
        location: null,
        assigned_user: { id: 'u-1', name: DENTISTA },
        lead: { id: 'lead-1', name: PACIENTE, phone: TEL, tenant_id: TENANT },
        patient: null,
        ...over,
      };
    }

    it('sendWhatsAppReminders — paciente: confirmação 48h e lembretes 24h/1h/15min', async () => {
      const casos: Record<string, any> = {};
      for (const min of [2880, 1440, 60, 15]) {
        const { worker, z } = lembretes();
        await worker.sendWhatsAppReminders(eventoLembrete(), min);
        casos[`${min} min antes`] = z.envios;
      }
      expect(casos).toMatchSnapshot();
    });

    it('sendWhatsAppReminders — lead (Comercial): confirmação 48h e lembretes 1 dia/1h/15min', async () => {
      const ligados = Object.fromEntries(COMERCIAL_AGENDA_IDS.map((id) => [`COMERCIAL_AGENDA_ENABLED_${id}_${TENANT}`, 'true']));
      const casos: Record<string, any> = {};
      for (const min of [2880, 1440, 60, 15]) {
        const { worker, z } = lembretes(ligados);
        await worker.sendWhatsAppReminders(
          eventoLembrete({ lead: { id: 'lead-1', name: PACIENTE, phone: TEL, tenant_id: TENANT, is_client: false } }),
          min,
        );
        casos[`${min} min antes`] = z.envios;
      }
      expect(casos).toMatchSnapshot();
    });

    it('sendWhatsAppReminders — legado jurídico (AUDIÊNCIA sem IA): template de fallback', async () => {
      const { worker, z } = lembretes();
      await worker.sendWhatsAppReminders(eventoLembrete({ type: 'AUDIENCIA', location: 'Fórum Exemplo' }), 1440);
      expect(z.envios).toMatchSnapshot();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Retorno de manutenção — agenda-extended/retorno-disparos.service.ts
// ═════════════════════════════════════════════════════════════════════════════

describe('retrato: retorno de manutenção → paciente (F1)', () => {
  it('apps/api/src/agenda-extended/retorno-disparos.service.ts — enviar (12 toques, textos de retorno-disparos.ts)', async () => {
    const g = gravador(
      banco({
        'patient.findFirst': () => ({
          id: 'pac-1', name: PACIENTE, phone: TEL, status: 'ACTIVE', lead_id: 'lead-1', lead: { contact_opt_out_at: null },
        }),
        'calendarEvent.count': () => 0,
        'auditLog.create': () => ({ id: 'marca-1' }),
        'dispatchLog.create': () => ({}),
      }),
    );
    const z = zap();
    const svc = new RetornoDisparosService(g.prisma, {} as any, z.whatsapp);
    // Hoje em Maceió = 20/10/2026. Prevista: 10 dias à frente / hoje / 1 mês atrás.
    const PREVISTA = {
      antes: { prevista: '2026-10-30', ultima: '2026-04-30' },
      no_dia: { prevista: '2026-10-20', ultima: '2026-04-20' },
      depois: { prevista: '2026-09-20', ultima: '2026-03-20' },
    } as const;
    const casos: Record<string, any> = {};
    for (const id of RETORNO_DISPARO_IDS) {
      const { familia, etapa } = parseRetornoDisparoId(id);
      const d = PREVISTA[etapa];
      const r = await (svc as any).enviar(
        TENANT,
        {
          id, familia, etapa, patientId: 'pac-1',
          ultima: new Date(`${d.ultima}T00:00:00.000Z`),
          prevista: new Date(`${d.prevista}T00:00:00.000Z`),
          chave: `pac-1:${familia}:${d.prevista}`,
          diasRestantes: 0,
        },
        'chip-clinica',
        AGORA,
      );
      expect([id, r]).toEqual([id, 'enviado']);
      casos[id] = z.envios.splice(0).map((e) => e.texto);
    }
    expect(casos).toMatchSnapshot();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Venda — commercial/quotes.service.ts e treatment-plan-contract.service.ts
// ═════════════════════════════════════════════════════════════════════════════

describe('retrato: fechamento da venda e orçamento → paciente (F1)', () => {
  const PACIENTE_VENDA = { name: PACIENTE, phone: TEL };
  const LIGADOS = {
    [`NEGOCIACAO_APROVADA_ENABLED_${TENANT}`]: 'true',
    [`BOLETO_INTRO_ENABLED_${TENANT}`]: 'true',
    [`BOLETO_DELIVERY_ENABLED_${TENANT}`]: 'true',
    [`COMPROVANTE_PAGAMENTO_ENABLED_${TENANT}`]: 'true',
    [`PIX_DELIVERY_ENABLED_${TENANT}`]: 'true',
  };

  function vendas(extra: Record<string, (a: any) => any> = {}, opts: { semPdf?: boolean } = {}) {
    const g = gravador(
      banco(
        {
          'treatmentPlanItem.findMany': () => [
            { quantity: 1, procedure: { name: 'Clareamento dental' } },
            { quantity: 2, procedure: { name: 'Restauração em resina' } },
          ],
          'treatmentPlan.findUnique': () => ({ quote_id: 'quote-1', patient: PACIENTE_VENDA }),
          ...extra,
        },
        LIGADOS,
      ),
    );
    const z = zap();
    const conv = conversaPaciente();
    const pdf: any = {
      generatePdf: async () => {
        if (opts.semPdf) throw new Error('sem PDF no retrato');
        return Buffer.from('%PDF-1.4 exemplo');
      },
    };
    const portal: any = { createMagicLink: async () => ({ link: 'https://portal.exemplo.test/p/token-exemplo' }) };
    // Sem Asaas: o PIX da entrada só sai se já estiver salvo na cobrança.
    const moduleRef: any = { get: () => { throw new Error('sem Asaas no retrato'); } };
    const svc = new QuotesService(
      g.prisma, moduleRef, z.whatsapp, portal, undefined, undefined, undefined, undefined, pdf,
      undefined, undefined, conv.messages, conv.conversations,
    );
    return { svc, g, z, conv };
  }

  it('apps/api/src/commercial/quotes.service.ts — sendNegociacaoAprovada (parcelado no boleto, à vista PIX e cartão) + PDF dos procedimentos', async () => {
    const casos: Record<string, any> = {};
    const termos = {
      'boleto: entrada + 10 parcelas': { entrada: 500, parcelas: 10, valorParcela: 250, total: 3000, forma: 'BOLETO' },
      'à vista no PIX': { total: 1500, forma: 'PIX' },
      'à vista no cartão': { total: 1500, forma: 'CREDIT_CARD' },
    };
    for (const [nome, t] of Object.entries(termos)) {
      const { svc, z } = vendas();
      await (svc as any).sendNegociacaoAprovada(TENANT, 'plan-1', PACIENTE_VENDA, t);
      casos[nome] = z.envios;
    }
    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/commercial/quotes.service.ts — sendApresentacao (o Financeiro se apresenta no fechamento)', async () => {
    const { svc, z } = vendas();
    await (svc as any).sendApresentacao(TENANT, 'plan-1', PACIENTE_VENDA);
    expect(z.envios).toMatchSnapshot();
  });

  it('apps/api/src/commercial/quotes.service.ts — sendEntradaCobranca (boleto do sinal com PIX e da entrada sem PIX)', async () => {
    const hoje = new Date('2026-10-20T15:00:00.000Z');
    const { svc, z } = vendas({
      'paymentGatewayCharge.findMany': () => [
        {
          id: 'ch-sinal', kind: 'SINAL', amount: 300, due_date: hoje, external_id: 'pay_sinal', gateway: 'ASAAS',
          boleto_url: 'https://asaas.exemplo.test/b/sinal.pdf', invoice_url: null, pix_copy_paste: `${PIX_EXEMPLO}-SINAL`,
        },
        {
          id: 'ch-entrada', kind: 'ENTRADA', amount: 700, due_date: hoje, external_id: 'pay_entrada', gateway: 'ASAAS',
          boleto_url: 'https://asaas.exemplo.test/b/entrada.pdf', invoice_url: null, pix_copy_paste: null,
        },
      ],
    });
    await (svc as any).sendEntradaCobranca(TENANT, 'plan-1', PACIENTE_VENDA);
    expect(z.envios).toMatchSnapshot();
  });

  it('apps/api/src/commercial/quotes.service.ts — sendComprovantePagamento (venda paga na clínica)', async () => {
    const casos: Record<string, any> = {};
    for (const forma of ['DINHEIRO', 'CARTAO', 'PIX_MAQUININHA']) {
      const { svc, z } = vendas();
      await (svc as any).sendComprovantePagamento(TENANT, 'plan-1', PACIENTE_VENDA, { total: 450, forma });
      casos[forma] = z.envios;
    }
    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/commercial/quotes.service.ts — sendPixDelivery (código PIX no fechamento)', async () => {
    const { svc, z } = vendas();
    await (svc as any).sendPixDelivery(TENANT, 'plan-1', PACIENTE_VENDA, PIX_EXEMPLO);
    expect(z.envios).toMatchSnapshot();
  });

  it('apps/api/src/commercial/quotes.service.ts — sendExpiryReminders (orçamento perto de expirar; cron desligado, chamada manual)', async () => {
    const { svc, z } = vendas({
      'quote.findMany': () => [
        { id: 'quote-1', total_value: 2500, valid_until: new Date('2026-10-23T15:00:00.000Z'), patient: { id: 'pac-1', name: PACIENTE, phone: TEL } },
      ],
    });
    await svc.sendExpiryReminders();
    expect(z.envios).toMatchSnapshot();
  });

  it('apps/api/src/commercial/quotes.service.ts — sendByWhatsapp (orçamento: legenda do PDF e texto sem PDF)', async () => {
    const orcamento = (over: Record<string, any> = {}) => ({
      id: 'quote-1',
      quote_number: 42,
      status: 'DRAFT',
      patient_id: 'pac-1',
      patient: { name: PACIENTE, phone: TEL },
      items: [{}, {}, {}],
      valid_until: new Date('2026-11-19T15:00:00.000Z'),
      total_value: 4200,
      discount_value: 300,
      _count: { attachments: 2 },
      ...over,
    });
    const casos: Record<string, any> = {};

    const a = vendas({ 'quote.update': () => ({}) });
    jest.spyOn(a.svc, 'findOne').mockResolvedValue(orcamento() as any);
    jest.spyOn(a.svc, 'resolvePatientWhatsappLead').mockResolvedValue('lead-1');
    const ra = await a.svc.sendByWhatsapp('quote-1', TENANT, 'user-1');
    expect(ra.link).toBe('https://portal.exemplo.test/p/token-exemplo');
    casos['com PDF, desconto, validade e anexos'] = a.conv.envios;

    const b = vendas({ 'quote.update': () => ({}), 'tenant.findUnique': () => ({ name: null }) }, { semPdf: true });
    jest.spyOn(b.svc, 'findOne').mockResolvedValue(
      orcamento({ status: 'SENT', items: [{}], valid_until: null, discount_value: 0, _count: { attachments: 0 } }) as any,
    );
    jest.spyOn(b.svc, 'resolvePatientWhatsappLead').mockResolvedValue('lead-1');
    await b.svc.sendByWhatsapp('quote-1', TENANT, 'user-1');
    casos['sem PDF, sem desconto/validade/anexos e clínica sem nome'] = b.conv.envios;

    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/commercial/treatment-plan-contract.service.ts — sendForSignature (link do TCLE + mensagem do ClickSign)', async () => {
    const g = gravador(
      banco({
        'treatmentPlan.findUnique': () => ({
          id: 'plan-1',
          status: 'PENDING_SIGNATURE',
          contract_signature_id: null,
          total_value: 1000,
          patient: {
            tenant_id: TENANT, lead_id: 'lead-1', name: PACIENTE, phone: TEL, email: EMAIL_PACIENTE,
            cpf: null, rg: null, birth_date: null,
          },
          items: [{ procedure: { name: 'Clareamento dental' }, quantity: 1, unit_price: 1000, total_price: 1000, tooth_fdi: null }],
        }),
        'treatmentPlan.update': () => ({}),
      }),
    );
    const conv = conversaPaciente();
    const assinaturas: any[] = [];
    const clicksign: any = {
      createGenericSignature: async (o: any) => {
        expect(Buffer.isBuffer(o.buffer) && o.buffer.subarray(0, 5).toString()).toBe('%PDF-');
        assinaturas.push({ ...o, buffer: '<PDF do TCLE>' });
        return { signingUrl: 'https://assinatura.exemplo.test/sign/abc', contractSignatureId: 'sig-1' };
      },
    };
    const svc = new TreatmentPlanContractService(g.prisma, clicksign, conv.messages, conv.conversations);
    const r = await svc.sendForSignature('plan-1', TENANT);
    expect(r).toEqual({ signingUrl: 'https://assinatura.exemplo.test/sign/abc', whatsappSent: true });
    expect({ clicksign: assinaturas, whatsapp: conv.envios }).toMatchSnapshot();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cobrança — payment-gateway.service.ts e boleto-delivery.service.ts
// ═════════════════════════════════════════════════════════════════════════════

describe('retrato: cobrança → paciente (F1)', () => {
  function pagamentos(settings: Record<string, string> = {}, extra: Record<string, (a: any) => any> = {}) {
    const g = gravador(
      banco(
        {
          'paymentGatewayCustomer.findFirst': () => ({ lead: { id: 'lead-1', name: PACIENTE, phone: TEL, tenant_id: TENANT } }),
          'patient.findFirst': () => ({ id: 'pac-1', name: PACIENTE, phone: TEL }),
          'installment.findUnique': () => ({ patient: { name: PACIENTE, email: EMAIL_PACIENTE } }),
          'message.create': () => ({}),
          'conversation.update': () => ({}),
          'dispatchLog.create': () => ({}),
          ...extra,
        },
        settings,
      ),
    );
    const z = zap();
    const c = correio(g.prisma);
    const svc = new PaymentGatewayService(g.prisma, {} as any, z.whatsapp, {} as any, {} as any, new EmailAutomationService(g.prisma, c.mail), {} as any);
    // A conversa do Financeiro (find-or-create em transação) não muda o texto: fixa.
    jest.spyOn(svc as any, 'findOrCreateFinanceiroConversation').mockResolvedValue({ id: 'conv-fin', instance_name: 'chip-financeiro' });
    return { svc, z, c };
  }

  it('apps/api/src/payment-gateway/payment-gateway.service.ts — notifyClientPaymentReceived (confirmação de pagamento)', async () => {
    const casos: Record<string, any> = {};
    const cenarios: Record<string, [any, any]> = {
      'PIX com descrição (tag interna sai)': [
        { customer: 'cus_1', value: 350, billingType: 'PIX', description: 'Parcela 3/10 — Maria Exemplo [plan:00000000-0000-0000-0000-0000000000aa]' },
        { tenant_id: TENANT, amount: 350, billing_type: 'PIX' },
      ],
      'boleto (linha do vencimento)': [
        { customer: 'cus_1', value: 250, billingType: 'BOLETO', description: 'Parcela 4/10' },
        { tenant_id: TENANT, amount: 250, billing_type: 'BOLETO', due_date: new Date('2026-10-19T00:00:00.000Z') },
      ],
      'cartão sem descrição': [
        { customer: 'cus_1', value: 1500, billingType: 'CREDIT_CARD' },
        { tenant_id: TENANT, amount: 1500, billing_type: 'CREDIT_CARD' },
      ],
    };
    for (const [nome, [dados, cobranca]] of Object.entries(cenarios)) {
      const { svc, z } = pagamentos();
      await (svc as any).notifyClientPaymentReceived(dados, cobranca);
      casos[nome] = z.envios;
    }
    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/payment-gateway/payment-gateway.service.ts — notifyClientChargeDeleted (estorno e cancelamento)', async () => {
    const casos: Record<string, any> = {};
    for (const status of ['REFUNDED', 'DELETED']) {
      const { svc, z } = pagamentos();
      await (svc as any).notifyClientChargeDeleted(
        { customer: 'cus_1', value: 350, description: 'Parcela 3/10 [plan:00000000-0000-0000-0000-0000000000aa]' },
        { tenant_id: TENANT, amount: 350 },
        status,
      );
      casos[status] = z.envios;
    }
    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/payment-gateway/payment-gateway.service.ts — resendChargeWhatsapp (botão "Reenviar" por forma de pagamento)', async () => {
    const vence = new Date('2026-10-25T15:00:00.000Z');
    const cobrancas: Record<string, any> = {
      PIX: { billing_type: 'PIX', invoice_url: 'https://pagamento.exemplo.test/fatura/1', pix_copy_paste: PIX_EXEMPLO },
      BOLETO: {
        billing_type: 'BOLETO', boleto_url: 'https://asaas.exemplo.test/b/parcela.pdf',
        invoice_url: 'https://pagamento.exemplo.test/fatura/2', boleto_barcode: '00000.00000 00000.000000 00000.000000 0 00000000000000',
      },
      CREDIT_CARD: { billing_type: 'CREDIT_CARD', invoice_url: 'https://pagamento.exemplo.test/fatura/3' },
      UNDEFINED: { billing_type: 'UNDEFINED', invoice_url: 'https://pagamento.exemplo.test/fatura/4' },
    };
    const casos: Record<string, any> = {};
    for (const [nome, cob] of Object.entries(cobrancas)) {
      const { svc, z } = pagamentos({}, {
        'paymentGatewayCharge.findFirst': () => ({ id: 'ch-1', tenant_id: TENANT, amount: 250, due_date: vence, customer_external_id: 'cus_1', ...cob }),
      });
      await svc.resendChargeWhatsapp('ch-1', TENANT);
      casos[nome] = z.envios;
    }
    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/payment-gateway/payment-gateway.service.ts — e-mails de pagamento atrasado e confirmado (variáveis reais)', async () => {
    const { svc, c } = pagamentos();
    await (svc as any).sendPaymentOverdueEmail({
      installment_id: 'inst-1', tenant_id: TENANT, amount: 250,
      due_date: new Date('2026-10-19T15:00:00.000Z'), invoice_url: 'https://pagamento.exemplo.test/fatura/2',
    });
    await (svc as any).sendPaymentConfirmedEmail(
      { installment_id: 'inst-1', tenant_id: TENANT, amount: 250 },
      { paymentDate: '2026-10-19T15:00:00.000Z' },
    );
    expect(c.enviados).toHaveLength(2);
    expect(c.enviados).toMatchSnapshot();
  });

  describe('apps/api/src/payment-gateway/boleto-delivery.service.ts', () => {
    const VENCE = new Date('2026-11-10T15:00:00.000Z');
    const parcela = (n: number) => ({
      kind: 'INSTALLMENT', external_id: `pay_p${n}`, boleto_url: `https://asaas.exemplo.test/b/parcela-${n}.pdf`,
      due_date: VENCE, amount: 250, description: `Parcela ${n}/3 — ${PACIENTE} [plan:plan-1]`,
    });
    const ENTRADA = {
      kind: 'ENTRADA', external_id: 'pay_entrada', boleto_url: 'https://asaas.exemplo.test/b/entrada.pdf',
      due_date: VENCE, amount: 500, description: `Entrada — ${PACIENTE} [plan:plan-1]`,
    };

    function entrega(cobrancas: any[], asaasOver: Record<string, any> = {}) {
      const g = gravador(banco({ 'paymentGatewayCharge.findMany': () => cobrancas, 'dispatchLog.create': () => ({}) }));
      const z = zap();
      const asaas: any = {
        getCharge: async (id: string) => ({ id, status: 'PENDING', installment: 'ins_1', bankSlipUrl: `https://asaas.exemplo.test/b/${id}.pdf` }),
        getInstallmentPaymentBook: async () => Buffer.from('%PDF-1.4 carnê do Asaas'),
        listCharges: async () => { throw new Error('sem lista no retrato'); },
        ...asaasOver,
      };
      const svc = new BoletoDeliveryService(g.prisma, asaas, z.whatsapp);
      return { svc, z };
    }

    it('sendBoletos — abertura + carnê do Asaas + boleto da entrada', async () => {
      const { svc, z } = entrega([ENTRADA, parcela(1), parcela(2), parcela(3)]);
      expect(await (svc as any).sendBoletos('plan-1', TENANT, PACIENTE, TEL, {})).toBe(true);
      expect(z.envios).toMatchSnapshot();
    });

    it('sendBoletos — boleto único à vista (sem parcelas)', async () => {
      const { svc, z } = entrega([{ ...ENTRADA, kind: null, amount: 1200, description: `Tratamento — ${PACIENTE} [plan:plan-1]` }]);
      expect(await (svc as any).sendBoletos('plan-1', TENANT, PACIENTE, TEL, {})).toBe(true);
      expect(z.envios).toMatchSnapshot();
    });

    it('sendBoletos — sem carnê na última tentativa: os boletos vão por link', async () => {
      const { svc, z } = entrega([parcela(1), parcela(2), parcela(3)], {
        getInstallmentPaymentBook: async () => { throw new Error('Asaas fora do ar no retrato'); },
      });
      jest.spyOn(svc as any, 'baixarPdf').mockRejectedValue(new Error('sem rede no retrato'));
      expect(await (svc as any).sendBoletos('plan-1', TENANT, PACIENTE, TEL, { ultimaTentativa: true })).toBe(true);
      expect(z.envios).toMatchSnapshot();
    });

    it('sendBoletos — carnê montado aqui com parcela faltando: a que faltou vai por link', async () => {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      const umPdf = Buffer.from(await doc.save({ useObjectStreams: false }));
      const { svc, z } = entrega([parcela(1), parcela(2), parcela(3)], {
        getInstallmentPaymentBook: async () => { throw new Error('Asaas fora do ar no retrato'); },
      });
      jest.spyOn(svc as any, 'baixarPdf').mockImplementation(async (url: any) => {
        if (String(url).endsWith('parcela-1.pdf')) return umPdf;
        throw new Error('sem rede no retrato');
      });
      expect(await (svc as any).sendBoletos('plan-1', TENANT, PACIENTE, TEL, {})).toBe(true);
      expect(z.envios).toMatchSnapshot();
    });

    it('sendCurrentBoleto — botão "mandar o boleto atual"', async () => {
      const g = gravador(
        banco({
          'treatmentPlan.findFirst': () => ({ id: 'plan-1' }),
          'paymentGatewayCharge.findMany': () => [
            { id: 'ch-1', external_id: 'pay_p1', boleto_url: 'https://asaas.exemplo.test/b/parcela-1.pdf', due_date: VENCE, customer_external_id: 'cus_1', treatment_plan: { patient: { name: PACIENTE, phone: TEL } } },
          ],
        }),
      );
      const z = zap();
      const svc = new BoletoDeliveryService(g.prisma, {} as any, z.whatsapp);
      expect((await svc.sendCurrentBoleto('plan-1', TENANT)).ok).toBe(true);
      expect(z.envios).toMatchSnapshot();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Pós-atendimento — post-care/post-care-templates.ts
// ═════════════════════════════════════════════════════════════════════════════

describe('retrato: pesquisa pós-atendimento → paciente (F1)', () => {
  it('apps/api/src/post-care/post-care-templates.ts — pergunta inicial (3 estilos), agradecimento e desculpas', () => {
    // A pergunta inicial sai pelo worker (retrato do worker); o agradecimento e o
    // pedido de desculpas saem pela API quando o paciente responde.
    const ctx = { patient_name: 'Maria', dentist_name: 'Dr(a). Ana Exemplo', procedure: 'limpeza' };
    expect({
      config_padrao: { ligado: POS_ATENDIMENTO_PADRAO.enabled, horas_depois: POS_ATENDIMENTO_PADRAO.delay_hours, estilo: POS_ATENDIMENTO_PADRAO.initial_choice },
      inicial: Object.fromEntries(
        (['descontraido', 'formal', 'breve'] as const).map((estilo) => [
          estilo,
          renderInitialMessage({ ...POS_ATENDIMENTO_PADRAO, initial_choice: estilo }, ctx),
        ]),
      ),
      inicial_sem_dados: renderInitialMessage(POS_ATENDIMENTO_PADRAO, { patient_name: '', dentist_name: '', procedure: '' }),
      agradecimento: renderThanks(POS_ATENDIMENTO_PADRAO, { patient_name: 'Maria' }),
      desculpas: renderApology(POS_ATENDIMENTO_PADRAO, { patient_name: 'Maria' }),
    }).toMatchSnapshot();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E-mails automáticos — email-automation/email-events.ts + EmailAutomationService
// ═════════════════════════════════════════════════════════════════════════════

describe('retrato: e-mails automáticos → paciente (F1)', () => {
  it('apps/api/src/email-automation/email-events.ts — catálogo (assunto, corpo e botão padrão)', () => {
    expect(
      EMAIL_EVENTS.map((e) => ({ key: e.key, assunto: e.defaultSubject, corpo: e.defaultBody, botao: e.ctaLabel ?? null })),
    ).toMatchSnapshot();
  });

  it('apps/api/src/email-automation/email-automation.service.ts — dispatch de cada evento (HTML que o paciente recebe)', async () => {
    const g = gravador(banco());
    const c = correio(g.prisma);
    const svc = new EmailAutomationService(g.prisma, c.mail);
    const casos: Record<string, any> = {};
    for (const ev of EMAIL_EVENTS) {
      // Variáveis de exemplo do próprio catálogo; o nome da clínica vem do tenant.
      const vars = Object.fromEntries(ev.variables.filter((v) => v.name !== 'clinica_nome').map((v) => [v.name, v.sample]));
      const ok = await svc.dispatch(ev.key, TENANT, EMAIL_PACIENTE, vars, {
        ctaUrl: ev.ctaLabel ? 'https://pagamento.exemplo.test/fatura/123' : undefined,
      });
      expect([ev.key, ok]).toEqual([ev.key, true]);
      casos[ev.key] = c.enviados.splice(0);
    }
    expect(casos).toMatchSnapshot();
  });

  it('apps/api/src/email-automation/email-automation.service.ts — sendDueTomorrowReminders (cron "vence amanhã")', async () => {
    const g = gravador(
      banco({
        'paymentGatewayCharge.findMany': () => [
          {
            id: 'ch-1', tenant_id: TENANT, amount: 350, due_date: new Date('2026-10-21T15:00:00.000Z'), billing_type: 'BOLETO',
            invoice_url: 'https://pagamento.exemplo.test/fatura/1', boleto_url: null,
            installment: { patient: { name: PACIENTE, email: EMAIL_PACIENTE } },
          },
        ],
        'paymentGatewayCharge.update': () => ({}),
      }),
    );
    const c = correio(g.prisma);
    await new EmailAutomationService(g.prisma, c.mail).sendDueTomorrowReminders();
    expect(c.enviados).toHaveLength(1);
    expect(c.enviados).toMatchSnapshot();
  });
});
