/**
 * F7 do laboratório — textos e configurações da agenda na Central (CalendarService com
 * o último parâmetro `lab`): padrões do laboratório × os da clínica, recusas no
 * servidor (antecedências, aniversário 2 e 3, testes que não existem no laboratório)
 * e o botão Testar com o cliente de exemplo do laboratório.
 *
 * Clínica: chamada sem o parâmetro, devolve exatamente os padrões de antes.
 *
 * Dados de exemplo (repositório público: nada real).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Logger } from '@nestjs/common';
import {
  BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO,
  DEFAULT_BIRTHDAY_GREETING,
  DEFAULT_DENTIST_DAILY_SUMMARY,
  DEFAULT_REMINDER_CONFIG,
  DENTIST_DAILY_SUMMARY_PADRAO_DO_LABORATORIO,
  LAB_AGENDA_TEXTOS,
  LAB_NEGOCIACAO,
  LAB_RECUSA_DISPAROS,
  LAB_TESTE_DA_CENTRAL,
  REMINDER_CONFIG_PADRAO_DO_LABORATORIO,
} from '@crm/shared';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';

const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const TEL = '82900000003';
const CONFIRMACAO_DA_CLINICA =
  'Oi {nome}, tudo bem? 😊\n\nAqui é pra confirmar seu atendimento com {dentista} amanhã, *{data}* às *{hora}*.\n{local_line}\nPosso confirmar sua presença? 🙂 Qualquer imprevisto, me avisa que a gente ajeita um novo horário.';

// ─── Carregador do CalendarService (o import dinâmico do @crm/shared vira require) ─
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
  const { outputText } = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), { fileName: arquivo, compilerOptions: OPCOES_TS });
  const modulo = { exports: {} as any };
  const requerer = (id: string) => require(id.startsWith('.') ? path.resolve(path.dirname(arquivo), id) : id);
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    modulo.exports, requerer, modulo, arquivo, path.dirname(arquivo),
  );
  return modulo.exports;
}
const { CalendarService } = carregarFonte('calendar/calendar.service.ts');

beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error'] as const) jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
});

/** Banco de teste: settings guardados por chave; grava cada operação. */
function montar(settings: Record<string, unknown> = {}, respostas: Record<string, (a: any) => any> = {}) {
  const ops: Array<[string, any]> = [];
  const guardados: Record<string, string> = Object.fromEntries(
    Object.entries(settings).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );
  const prisma: any = new Proxy({}, {
    get(_a, modelo: string | symbol) {
      if (typeof modelo !== 'string' || modelo === 'then') return undefined;
      return new Proxy({}, {
        get(_m, metodo: string | symbol) {
          if (typeof metodo !== 'string' || metodo === 'then') return undefined;
          return async (args: any) => {
            const op = `${modelo}.${metodo}`;
            ops.push([op, args]);
            if (respostas[op]) return respostas[op](args);
            if (op === 'globalSetting.findUnique') return args.where.key in guardados ? { value: guardados[args.where.key] } : null;
            if (op === 'globalSetting.upsert') {
              guardados[args.where.key] = args.update.value;
              return { key: args.where.key };
            }
            return metodo === 'findMany' ? [] : null;
          };
        },
      });
    },
  });
  const whatsapp = { sendText: jest.fn(async (..._a: any[]) => ({ key: { id: 'wamid-teste' } })) };
  const svc = new CalendarService(prisma, {} as any, {} as any, {} as any, whatsapp, {} as any, {} as any);
  const de = (op: string) => ops.filter(([o]) => o === op).map(([, a]) => a);
  return { svc, ops, de, whatsapp, guardados };
}
async function erro(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('era para lançar e não lançou');
}
const recusa = (e: any) => [e?.getStatus?.(), e?.getResponse?.()?.code, e?.getResponse?.()?.message];

describe('Padrões: laboratório × clínica', () => {
  it('lembretes: clínica = DEFAULT de antes; laboratório = 48 h e 24 h pelo WhatsApp com o texto dele', async () => {
    const m = montar();
    expect(await m.svc.getReminderConfig(CLINICA)).toBe(DEFAULT_REMINDER_CONFIG);
    expect(await m.svc.getReminderConfig(LAB, true)).toEqual(REMINDER_CONFIG_PADRAO_DO_LABORATORIO);
  });

  it('lembretes salvos: no laboratório saem 1 h/15 min/e-mail e texto vazio volta para o dele; na clínica, igual a antes', async () => {
    const salvo = {
      enabled: false,
      default_antecedencias: [
        { minutes_before: 60, channel: 'WHATSAPP' },
        { minutes_before: 2880, channel: 'WHATSAPP' },
        { minutes_before: 1440, channel: 'EMAIL' },
        { minutes_before: 1440, channel: 'WHATSAPP' },
        { minutes_before: 30, channel: 'PUSH' },
      ],
      templates: { consulta_confirmacao: '  ', consulta_24h: 'Oi {nome}, amanhã tem {tipo}.' },
    };
    const m = montar({ [`REMINDER_CONFIG_${LAB}`]: salvo, [`REMINDER_CONFIG_${CLINICA}`]: salvo });
    expect(await m.svc.getReminderConfig(LAB, true)).toEqual({
      enabled: false,
      default_antecedencias: [
        { minutes_before: 2880, channel: 'WHATSAPP' },
        { minutes_before: 1440, channel: 'WHATSAPP' },
        { minutes_before: 30, channel: 'PUSH' },
      ],
      templates: {
        consulta_confirmacao: LAB_AGENDA_TEXTOS.lembrete48h,
        consulta_24h: 'Oi {nome}, amanhã tem {tipo}.',
        consulta_1h: '',
        consulta_15min: '',
      },
    });
    expect(await m.svc.getReminderConfig(CLINICA)).toEqual({
      enabled: false,
      default_antecedencias: salvo.default_antecedencias,
      templates: { ...DEFAULT_REMINDER_CONFIG.templates, ...salvo.templates },
    });
  });

  it('confirmação de 24 h e remarcação: o texto do laboratório no laboratório, o da clínica na clínica', async () => {
    const m = montar({ [`APPOINTMENT_CONFIRMATION_TEMPLATE_${LAB}`]: { template: '' } });
    expect(await m.svc.getAppointmentConfirmationConfig(CLINICA)).toEqual({ template: CONFIRMACAO_DA_CLINICA });
    expect(await m.svc.getAppointmentConfirmationConfig(LAB, true)).toEqual({ template: LAB_AGENDA_TEXTOS.confirmacao24h });
    expect(await m.svc.getAppointmentRescheduledConfig(CLINICA)).toEqual({ template: m.svc.DEFAULT_RESCHEDULED_TEMPLATE });
    expect(await m.svc.getAppointmentRescheduledConfig(LAB, true)).toEqual({ template: LAB_AGENDA_TEXTOS.remarcacao });
  });

  it('Restaurar padrões (texto vazio) no laboratório: os setters devolvem o texto do laboratório', async () => {
    const m = montar();
    expect(await m.svc.setAppointmentConfirmationConfig(LAB, { template: '' }, true)).toEqual({ template: LAB_AGENDA_TEXTOS.confirmacao24h });
    expect(await m.svc.setAppointmentRescheduledConfig(LAB, { template: '' }, true)).toEqual({ template: LAB_AGENDA_TEXTOS.remarcacao });
    expect(await m.svc.setAppointmentConfirmationConfig(CLINICA, { template: '' })).toEqual({ template: CONFIRMACAO_DA_CLINICA });
  });

  it('resumo do dia: clínica = DEFAULT; laboratório = resumo de coleta, prova e entrega (desligado); texto vazio volta para o dele', async () => {
    const m = montar({ [`DENTIST_DAILY_SUMMARY_${LAB}`]: { enabled: true, template: '' } });
    expect(await m.svc.getDentistDailySummaryConfig(CLINICA)).toBe(DEFAULT_DENTIST_DAILY_SUMMARY);
    expect(await m.svc.getDentistDailySummaryConfig(undefined)).toBe(DEFAULT_DENTIST_DAILY_SUMMARY);
    expect(await m.svc.getDentistDailySummaryConfig('outro-lab', true)).toEqual(DENTIST_DAILY_SUMMARY_PADRAO_DO_LABORATORIO);
    expect(await m.svc.getDentistDailySummaryConfig(LAB, true)).toEqual({ ...DENTIST_DAILY_SUMMARY_PADRAO_DO_LABORATORIO, enabled: true });
    expect(await m.svc.setDentistDailySummaryConfig(LAB, { template: '' }, true)).toEqual({ ...DENTIST_DAILY_SUMMARY_PADRAO_DO_LABORATORIO, enabled: true });
  });

  it('aniversário: clínica = DEFAULT; laboratório = só a mensagem clássica, a 2 e a 3 sempre desligadas', async () => {
    const m = montar({ [`BIRTHDAY_GREETING_${LAB}`]: { enabled: true, message2_enabled: true, message3_enabled: true } });
    expect(await m.svc.getBirthdayGreetingConfig(CLINICA)).toBe(DEFAULT_BIRTHDAY_GREETING);
    expect(await m.svc.getBirthdayGreetingConfig('outro-lab', true)).toEqual(BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO);
    expect(await m.svc.getBirthdayGreetingConfig(LAB, true)).toEqual({
      ...BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO,
      enabled: true,
      message2_enabled: false,
      message3_enabled: false,
    });
  });

  it('texto salvo com palavra de clínica: o editor mostra o padrão do laboratório, que é o que sai', async () => {
    const m = montar({
      [`REMINDER_CONFIG_${LAB}`]: { templates: { consulta_24h: 'Oi {nome}, amanhã tem consulta às {hora}.' } },
      [`BIRTHDAY_GREETING_${LAB}`]: { enabled: true, template: 'Parabéns, {nome}! Venha fazer seu tratamento.' },
    });
    expect((await m.svc.getReminderConfig(LAB, true)).templates.consulta_24h).toBe(LAB_AGENDA_TEXTOS.lembrete24h);
    expect((await m.svc.getBirthdayGreetingConfig(LAB, true)).template).toBe(BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO.template);
  });
});

describe('Recusas do laboratório no servidor', () => {
  it('lembretes: 1 h, 15 min, outra antecedência ou e-mail são recusados e nada é gravado', async () => {
    const proibidos = [
      { default_antecedencias: [{ minutes_before: 60, channel: 'WHATSAPP' }] },
      { default_antecedencias: [{ minutes_before: 15, channel: 'WHATSAPP' }] },
      { default_antecedencias: [{ minutes_before: 720, channel: 'WHATSAPP' }] },
      { default_antecedencias: [{ minutes_before: 1440, channel: 'EMAIL' }] },
      { templates: { consulta_1h: 'Falta 1 hora' } },
      { templates: { consulta_15min: 'Falta pouco' } },
    ];
    for (const cfg of proibidos) {
      const m = montar();
      const e = await erro(m.svc.setReminderConfig(LAB, cfg, true));
      expect(recusa(e)).toEqual([403, CODIGO_VERTICAL_NEGADA, LAB_RECUSA_DISPAROS.antecedencia]);
      expect(m.de('globalSetting.upsert')).toEqual([]);
    }
  });

  it('lembretes: o texto de 48 h segue as regras dos outros textos', async () => {
    const m = montar();
    expect((await erro(m.svc.setReminderConfig(LAB, { templates: { consulta_confirmacao: 5 } }, true))).message).toBe(
      'template consulta_confirmacao deve ser string',
    );
    expect((await erro(m.svc.setReminderConfig(LAB, { templates: { consulta_confirmacao: 'x'.repeat(1501) } }, true))).message).toBe(
      'template consulta_confirmacao ultrapassa 1500 caracteres',
    );
    expect(m.de('globalSetting.upsert')).toEqual([]);
  });

  it('lembretes: 48 h e 24 h pelo WhatsApp (e o PUSH) gravam; a clínica continua gravando 1 h como antes', async () => {
    const lab = montar();
    const r = await lab.svc.setReminderConfig(
      LAB,
      {
        default_antecedencias: [
          { minutes_before: 2880, channel: 'WHATSAPP' },
          { minutes_before: 1440, channel: 'WHATSAPP' },
          { minutes_before: 30, channel: 'PUSH' },
        ],
        templates: { consulta_confirmacao: 'Oi {nome}!', consulta_24h: '', consulta_1h: '', consulta_15min: '' },
      },
      true,
    );
    expect(lab.de('globalSetting.upsert').map((a: any) => a.where.key)).toEqual([`REMINDER_CONFIG_${LAB}`]);
    expect(r.templates).toEqual({ ...REMINDER_CONFIG_PADRAO_DO_LABORATORIO.templates, consulta_confirmacao: 'Oi {nome}!' });

    const clinica = montar();
    await clinica.svc.setReminderConfig(CLINICA, { default_antecedencias: [{ minutes_before: 60, channel: 'WHATSAPP' }] });
    expect(clinica.de('globalSetting.upsert').map((a: any) => a.where.key)).toEqual([`REMINDER_CONFIG_${CLINICA}`]);
  });

  it('aniversário: ligar a 2 ou a 3, ou dar texto a elas, é recusado e nada é gravado', async () => {
    const proibidos = [
      { message2_enabled: true },
      { message3_enabled: true },
      { message2_template: 'Que Deus abençoe' },
      { message3_template: 'Ganhe um presente' },
    ];
    for (const cfg of proibidos) {
      const m = montar();
      const e = await erro(m.svc.setBirthdayGreetingConfig(LAB, cfg, true));
      expect(recusa(e)).toEqual([403, CODIGO_VERTICAL_NEGADA, LAB_RECUSA_DISPAROS.aniversario]);
      expect(m.de('globalSetting.upsert')).toEqual([]);
    }
  });

  it('aniversário: salvar a clássica no laboratório não grava texto de clínica na chave dele', async () => {
    const m = montar();
    await m.svc.setBirthdayGreetingConfig(LAB, { enabled: true, send_at: '09:00', message2_enabled: false, message2_template: '' }, true);
    const gravado = JSON.parse(m.guardados[`BIRTHDAY_GREETING_${LAB}`]);
    expect(gravado).toEqual({ ...BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO, enabled: true, send_at: '09:00' });
    const texto = JSON.stringify(gravado);
    for (const daClinica of [DEFAULT_BIRTHDAY_GREETING.template, DEFAULT_BIRTHDAY_GREETING.message2_template, DEFAULT_BIRTHDAY_GREETING.message3_template]) {
      if (daClinica) expect(texto).not.toContain(JSON.stringify(daClinica).slice(1, -1));
    }
  });

  it.each(['nps', 'recall_preventivo', 'confirmacao_orto', 'confirmacao_orto_imediata', 'lembrete_orto_1h', 'comercial_confirmacao', 'lembrete_1h', 'lembrete_15min', 'aniversario_desejo', 'aniversario_presente', 'boleto_intro', 'pix_delivery'])(
    'Testar "%s" no laboratório: recusado antes de escolher o chip, nada é lido nem enviado',
    async (id) => {
      const m = montar();
      const e = await erro(m.svc.sendTestDisparo(LAB, id, TEL, undefined, true));
      expect(recusa(e)).toEqual([403, CODIGO_VERTICAL_NEGADA, LAB_RECUSA_DISPAROS.teste]);
      expect(m.ops).toEqual([]);
      expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    },
  );
});

describe('Testar da Central no laboratório', () => {
  const comChip = (extra: Record<string, (a: any) => any> = {}) => ({
    'instance.findFirst': ({ where }: any) => ({ name: `chip-${where.purpose ?? 'qualquer'}-${where.tenant_id}` }),
    'tenant.findUnique': ({ where }: any) => ({ name: where.id === LAB ? 'Laboratório Exemplo' : 'Clínica Exemplo' }),
    ...extra,
  });

  it('lembrete de 48 h: cliente, tipo (coleta) e endereço de exemplo do laboratório; sem anexos', async () => {
    const m = montar({}, comChip());
    const r = await m.svc.sendTestDisparo(LAB, 'confirmacao_48h', TEL, undefined, true);
    expect(r.message).toBe(
      'Oi Carlos (teste)! Lembrete do laboratório: *06/05* às *14:00* passamos no consultório para a coleta do seu trabalho.\n' +
        `📍 ${LAB_TESTE_DA_CENTRAL.local}\n\n` +
        'Se precisar mudar, é só responder aqui.',
    );
    expect(m.whatsapp.sendText.mock.calls[0].slice(0, 3)).toEqual([`55${TEL}`, r.message, `chip-CLINICA-${LAB}`]);
    expect(r.anexos).toEqual({ enviados: 0, falhas: [] });
    expect(m.ops.some(([o]) => o.startsWith('disparoAnexo.'))).toBe(false);
    // O teste não lê a equipe da conta (o cliente é de exemplo).
    expect(m.de('user.findFirst')).toEqual([]);
  });

  it('resumo do dia: a agenda de exemplo é de coleta', async () => {
    const m = montar({}, comChip());
    const r = await m.svc.sendTestDisparo(LAB, 'resumo_dentista', TEL, undefined, true);
    expect(r.message).toBe(
      'Bom dia, Carlos (teste)! 👋\n\nSua agenda hoje (06/05) tem 1 coleta(s), prova(s) e entrega(s):\n\n' +
        `${LAB_TESTE_DA_CENTRAL.agenda}\n\nBom trabalho!`,
    );
  });

  it('aniversário e confirmação: textos do laboratório; {clinica} é o nome do laboratório', async () => {
    const m = montar({}, comChip());
    expect((await m.svc.sendTestDisparo(LAB, 'aniversario', TEL, undefined, true)).message).toBe(
      'Feliz aniversário, Carlos (teste)! A equipe do laboratório deseja um dia excelente pra você. Obrigado pela parceria de sempre!',
    );
    const c = await m.svc.sendTestDisparo(LAB, 'confirmacao', TEL, 'Oi {nome}, {tipo} em {clinica}.', true);
    expect(c.message).toBe('Oi Carlos (teste), coleta em Laboratório Exemplo.');
  });

  it('orçamento aprovado sem texto na tela: o padrão do laboratório, pelo chip do Financeiro', async () => {
    const m = montar({}, comChip());
    const r = await m.svc.sendTestDisparo(LAB, 'negociacao_aprovada', TEL, undefined, true);
    expect(r.message.startsWith('Olá, Carlos (teste)! Seu orçamento de trabalho foi *aprovado*.')).toBe(true);
    expect(r.message).toContain(LAB_TESTE_DA_CENTRAL.itens);
    expect(r.message).not.toContain('Clareamento');
    expect(LAB_NEGOCIACAO.parcelado).toContain('{itens}');
    expect(m.whatsapp.sendText.mock.calls[0][2]).toBe(`chip-FINANCEIRO-${LAB}`);
  });

  it('clínica: o Testar de antes (paciente de exemplo, dentista da conta, agenda de avaliação)', async () => {
    const m = montar({}, comChip({ 'user.findFirst': () => ({ name: 'Dra. Bia Exemplo' }) }));
    const r = await m.svc.sendTestDisparo(CLINICA, 'confirmacao', TEL);
    expect(r.message).toBe(
      'Oi Felipe (teste), tudo bem? 😊\n\nAqui é pra confirmar seu atendimento com Dra. Bia Exemplo amanhã, *06/05* às *14:00*.\n' +
        '📍 (endereço não cadastrado — preencha em Configurações › Identidade)\n\n' +
        'Posso confirmar sua presença? 🙂 Qualquer imprevisto, me avisa que a gente ajeita um novo horário.',
    );
    expect(m.de('user.findFirst')).toHaveLength(1);
    const resumo = await m.svc.sendTestDisparo(CLINICA, 'resumo_dentista', TEL, '{agenda}');
    expect(resumo.message).toBe('- 14:00  Felipe (teste) (Avaliacao)');
  });
});
