/**
 * F7 do laboratório — Central de Disparos no servidor (FollowupController e
 * FollowupService).
 *
 * O controller passa pedidoDeLaboratorio(req.user) como último argumento de
 * setOperacionalToggle, getCobrancaTemplate e setCobrancaTemplate. No laboratório:
 *   - liga/desliga: aviso que não existe nele (pós-atendimento, recall, alertas de
 *     tarefa, ortodontia, agenda do comercial, reativação, retorno de manutenção,
 *     pacientes sem agendamento, triagem, aviso da IA, comprovante, envio do PIX) é
 *     recusado com 403 VERTICAL_DENIED e nada é gravado; o resto, régua de cobrança
 *     inclusive, grava a MESMA chave da clínica, na conta do laboratório;
 *   - textos de cobrança: só os da lista (orçamento aprovado parcelado e à vista, a
 *     confirmação de pagamento e a régua), com o padrão do laboratório; o resto é recusado.
 *
 * Clínica (lab = false): para todo `which`, as operações de 9eb61bff (a tabela abaixo
 * foi gerada rodando o código de 9eb61bff), sem ler a lista de laboratórios.
 *
 * Banco de teste: um gravador de operações. Dados de exemplo (repositório público).
 */
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import {
  __limparCacheLabTenants,
  COMERCIAL_AGENDA_IDS,
  DEFAULT_CONFIRMACAO_PAGAMENTO,
  LAB_NEGOCIACAO,
  LAB_RECUSA_DISPAROS,
  COBRANCA_STAGES,
  COBRANCA_TIPOS,
  REATIVACAO_TOGGLE_IDS,
  REGUA_DO_LABORATORIO,
  RETORNO_DISPARO_IDS,
  padraoFinDoLaboratorio,
  defaultFinTemplate,
  getLabTenantIds,
} from '@crm/shared';
import { FollowupService } from './followup.service';
import { FollowupController } from './followup.controller';

const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';

beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
beforeEach(() => __limparCacheLabTenants());

// ─── Banco de teste (gravador) ───────────────────────────────────────────────

type Op = [string, any];
function banco(labs: string[] = [], respostas: Record<string, (a: any) => any> = {}) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const perfis = jest.fn(async () => labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === 'tenantBusinessProfile') return { findMany: perfis };
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany' || metodo === 'groupBy') return [];
                if (metodo === 'upsert') return { id: `upd-${modelo}` };
                return null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );
  return { prisma, ops, perfis, svc: new FollowupService(prisma, {} as any) };
}

/** O erro que a promessa lançou (falha o teste se não lançar). */
async function erro(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('era para lançar e não lançou');
}

// ─── Operações da clínica em 9eb61bff ────────────────────────────────────────

/**
 * Chave gravada por `which` ('@' = a conta). 'b' = upsert de String(enabled);
 * 'j' = lê a chave e grava o JSON de antes com { enabled } por cima. O 'pos' tem
 * caminho próprio (config do pós-atendimento da conta) e fica em opsEsperadas.
 */
const GRAVACAO_DA_CLINICA: Record<string, [string, 'b' | 'j']> = {
  confirmacao: ['APPOINTMENT_CONFIRMATION_ENABLED_@', 'b'],
  lembrete: ['REMINDER_CONFIG_@', 'j'],
  dentista: ['DENTIST_DAILY_SUMMARY_@', 'j'],
  aniversario: ['BIRTHDAY_GREETING_@', 'j'],
  reagendamento: ['APPOINTMENT_RESCHEDULED_ENABLED_@', 'b'],
  confirmacao_pagamento: ['PAYMENT_CONFIRMATION_ENABLED_@', 'b'],
  boleto_1d_antes: ['BOLETO_1D_ANTES_@', 'b'],
  boleto_no_dia: ['BOLETO_NO_DIA_@', 'b'],
  boleto_atraso_1d: ['BOLETO_ATRASO_1D_@', 'b'],
  boleto_atraso_2d: ['BOLETO_ATRASO_2D_@', 'b'],
  boleto_atraso_3d: ['BOLETO_ATRASO_3D_@', 'b'],
  boleto_atraso_15d: ['BOLETO_ATRASO_15D_@', 'b'],
  boleto_atraso_30d: ['BOLETO_ATRASO_30D_@', 'b'],
  boleto_atrasado: ['BOLETO_ATRASADO_@', 'b'],
  confirmacao_orto: ['APPOINTMENT_CONFIRMATION_ORTO_ENABLED_@', 'b'],
  lembrete_orto_1h: ['APPOINTMENT_ORTO_REMINDER_ENABLED_@', 'b'],
  confirmacao_orto_imediata: ['APPOINTMENT_ORTO_IMMEDIATE_ENABLED_@', 'b'],
  pacientes_sem_agendamento: ['PACIENTES_SEM_AGENDAMENTO_@', 'b'],
  orto_ordem_chegada: ['ORTO_ORDEM_CHEGADA_@', 'b'],
  pacientes_sem_agendamento_orto: ['PACIENTES_SEM_AGENDAMENTO_ORTO_@', 'b'],
  boleto_intro: ['BOLETO_INTRO_ENABLED_@', 'b'],
  negociacao_aprovada: ['NEGOCIACAO_APROVADA_ENABLED_@', 'b'],
  negociacao_aprovada_avista: ['NEGOCIACAO_APROVADA_AVISTA_ENABLED_@', 'b'],
  comprovante_pagamento: ['COMPROVANTE_PAGAMENTO_ENABLED_@', 'b'],
  boleto_delivery: ['BOLETO_DELIVERY_ENABLED_@', 'b'],
  pix_delivery: ['PIX_DELIVERY_ENABLED_@', 'b'],
  daily_summary: ['DAILY_SUMMARY_ENABLED_@', 'b'],
  venda_feita: ['VENDA_FEITA_ENABLED_@', 'b'],
  recall_preventivo: ['RECALL_PREVENTIVO_ENABLED_@', 'b'],
  task_alerts: ['TASK_ALERTS_ENABLED_@', 'b'],
  nao_paciente_triage: ['NAO_PACIENTE_TRIAGE_ENABLED_@', 'b'],
  admin_agendamento_ia: ['ADMIN_AGENDAMENTO_IA_ENABLED_@', 'b'],
  admin_agendamento_equipe: ['ADMIN_AGENDAMENTO_EQUIPE_ENABLED_@', 'b'],
  block_sched_on_overdue: ['BLOCK_SCHED_ON_OVERDUE_@', 'b'],
  comercial_confirmacao: ['COMERCIAL_AGENDA_ENABLED_comercial_confirmacao_@', 'b'],
  comercial_confirmacao_48h: ['COMERCIAL_AGENDA_ENABLED_comercial_confirmacao_48h_@', 'b'],
  comercial_lembrete_1dia: ['COMERCIAL_AGENDA_ENABLED_comercial_lembrete_1dia_@', 'b'],
  comercial_lembrete_1h: ['COMERCIAL_AGENDA_ENABLED_comercial_lembrete_1h_@', 'b'],
  comercial_lembrete_15min: ['COMERCIAL_AGENDA_ENABLED_comercial_lembrete_15min_@', 'b'],
  comercial_reagendamento: ['COMERCIAL_AGENDA_ENABLED_comercial_reagendamento_@', 'b'],
  reativacao_leads: ['REATIVACAO_LEADS_ENABLED_@', 'b'],
  reativacao_novo: ['REATIVACAO_NOVO_ENABLED_@', 'b'],
  reativacao_conversa: ['REATIVACAO_CONVERSA_ENABLED_@', 'b'],
  reativacao_convite: ['REATIVACAO_CONVITE_ENABLED_@', 'b'],
  reativacao_agendado: ['REATIVACAO_AGENDADO_ENABLED_@', 'b'],
  reativacao_orcamento: ['REATIVACAO_ORCAMENTO_ENABLED_@', 'b'],
  retorno_limpeza_antes: ['RETORNO_LIMPEZA_ANTES_ENABLED_@', 'b'],
  retorno_limpeza_no_dia: ['RETORNO_LIMPEZA_NO_DIA_ENABLED_@', 'b'],
  retorno_limpeza_depois: ['RETORNO_LIMPEZA_DEPOIS_ENABLED_@', 'b'],
  retorno_clareamento_antes: ['RETORNO_CLAREAMENTO_ANTES_ENABLED_@', 'b'],
  retorno_clareamento_no_dia: ['RETORNO_CLAREAMENTO_NO_DIA_ENABLED_@', 'b'],
  retorno_clareamento_depois: ['RETORNO_CLAREAMENTO_DEPOIS_ENABLED_@', 'b'],
  retorno_faceta_resina_antes: ['RETORNO_FACETA_RESINA_ANTES_ENABLED_@', 'b'],
  retorno_faceta_resina_no_dia: ['RETORNO_FACETA_RESINA_NO_DIA_ENABLED_@', 'b'],
  retorno_faceta_resina_depois: ['RETORNO_FACETA_RESINA_DEPOIS_ENABLED_@', 'b'],
  retorno_lentes_porcelana_antes: ['RETORNO_LENTES_PORCELANA_ANTES_ENABLED_@', 'b'],
  retorno_lentes_porcelana_no_dia: ['RETORNO_LENTES_PORCELANA_NO_DIA_ENABLED_@', 'b'],
  retorno_lentes_porcelana_depois: ['RETORNO_LENTES_PORCELANA_DEPOIS_ENABLED_@', 'b'],
};

const F = (key: string): Op => ['globalSetting.findUnique', { where: { key } }];
const U = (key: string, value: string): Op => ['globalSetting.upsert', { where: { key }, create: { key, value }, update: { value } }];

function opsEsperadas(which: string, enabled: boolean, conta: string): Op[] {
  if (which === 'pos') {
    return [
      F(`POST_CARE_CONFIG_${conta}`),
      ['tenant.findUnique', { where: { id: conta }, select: { created_at: true } }],
      F('POST_CARE_CONFIG'),
      U(`POST_CARE_CONFIG_${conta}`, JSON.stringify({ enabled })),
    ];
  }
  const [chave, forma] = GRAVACAO_DA_CLINICA[which];
  const key = chave.replace('@', conta);
  if (forma === 'b') return [U(key, String(enabled))];
  const patch = which === 'aniversario' && !enabled ? { enabled: false, message2_enabled: false, message3_enabled: false } : { enabled };
  return [F(key), U(key, JSON.stringify(patch))];
}

const TODOS = ['pos', ...Object.keys(GRAVACAO_DA_CLINICA)];

// ─── O que o laboratório liga, só desliga e não tem ──────────────────────────

const LIBERADOS_NO_LAB = [
  ...REGUA_DO_LABORATORIO,
  'confirmacao',
  'lembrete',
  'reagendamento',
  'dentista',
  'aniversario',
  'negociacao_aprovada',
  'negociacao_aprovada_avista',
  'confirmacao_pagamento',
  'daily_summary',
  'venda_feita',
  'admin_agendamento_equipe',
  'block_sched_on_overdue',
];
const ESCONDIDOS_NO_LAB = [
  'pos',
  'recall_preventivo',
  'task_alerts',
  'confirmacao_orto',
  'lembrete_orto_1h',
  'confirmacao_orto_imediata',
  'orto_ordem_chegada',
  'pacientes_sem_agendamento',
  'pacientes_sem_agendamento_orto',
  'nao_paciente_triage',
  'admin_agendamento_ia',
  'comprovante_pagamento',
  'pix_delivery',
  ...COMERCIAL_AGENDA_IDS,
  ...REATIVACAO_TOGGLE_IDS,
  ...RETORNO_DISPARO_IDS,
];

describe('liga/desliga da Central — clínica (lab = false): as operações de 9eb61bff', () => {
  it('a tabela cobre todo which que existia e as três listas do laboratório, sem sobra nem repetição', () => {
    expect(TODOS).toHaveLength(59);
    expect([...LIBERADOS_NO_LAB, ...ESCONDIDOS_NO_LAB].sort()).toEqual([...TODOS].sort());
  });

  it.each(TODOS)('%s: liga e desliga com as mesmas operações e a mesma resposta, sem leitura nova da lista de laboratórios', async (which) => {
    for (const enabled of [true, false]) {
      for (const labs of [[], [LAB]]) {
        const b = banco(labs);
        const r = await b.svc.setOperacionalToggle(CLINICA, which, enabled);
        expect([which, enabled, b.ops]).toEqual([which, enabled, opsEsperadas(which, enabled, CLINICA)]);
        expect(r).toEqual({ ok: true, which, enabled });
        // Chamado sem o 4º argumento (como os retratos) e com false (como o controller): igual.
        const c = banco(labs);
        await c.svc.setOperacionalToggle(CLINICA, which, enabled, false);
        expect(c.ops).toEqual(b.ops);
        // O 'pos' já lia a lista em 9eb61bff (a conta de laboratório não herda a config global).
        if (which !== 'pos') {
          expect(b.perfis).not.toHaveBeenCalled();
          expect(c.perfis).not.toHaveBeenCalled();
        }
      }
    }
  });

  it('which que não existe: o mesmo 400 de antes, nada gravado', async () => {
    const b = banco();
    const e = await erro(b.svc.setOperacionalToggle(CLINICA, 'nao_existe', true));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toEqual({ message: 'toggle invalido: nao_existe', error: 'Bad Request', statusCode: 400 });
    expect(b.ops).toEqual([]);
  });
});

describe('leitura dos cards: envio dos boletos no laboratório não herda da apresentação', () => {
  const soApresentacao = (conta: string) => ({
    'globalSetting.findUnique': ({ where }: any) => (where.key === `BOLETO_INTRO_ENABLED_${conta}` ? { value: 'true' } : null),
    'globalSetting.findMany': () => [],
    'calendarEvent.count': () => 0,
    'patient.findMany': () => [],
  });

  it('chave ausente com a apresentação ligada: desligado no laboratório; herda na clínica', async () => {
    const noLab: any = await banco([LAB], soApresentacao(LAB)).svc.getOperacional(LAB, true);
    expect(noLab.boleto_intro).toEqual({ enabled: true });
    expect(noLab.boleto_delivery).toEqual({ enabled: false });
    const naClinica: any = await banco([LAB], soApresentacao(CLINICA)).svc.getOperacional(CLINICA);
    expect(naClinica.boleto_delivery).toEqual({ enabled: true });
  });

  it('chave ausente: todo marco da régua lê desligado na conta nova', async () => {
    const r: any = await banco([LAB], { 'globalSetting.findMany': () => [] }).svc.getOperacional(LAB, true);
    for (const id of REGUA_DO_LABORATORIO) expect([id, r[id]]).toEqual([id, { enabled: false }]);
    expect(r.block_sched_on_overdue).toEqual({ enabled: false });
  });
});

describe('liga/desliga da Central — laboratório (lab = true)', () => {
  const recusa = (e: any) => [e?.constructor?.name, e?.getStatus?.(), e?.getResponse?.()];

  it.each(ESCONDIDOS_NO_LAB)('%s: aviso que não existe no laboratório, recusado (ligar e desligar) sem gravar nada', async (which) => {
    for (const enabled of [true, false]) {
      const b = banco([LAB]);
      const e = await erro(b.svc.setOperacionalToggle(LAB, which, enabled, true));
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(recusa(e)).toEqual(['ForbiddenException', 403, { message: LAB_RECUSA_DISPAROS.escondido, code: 'VERTICAL_DENIED' }]);
      expect(b.ops).toEqual([]);
    }
  });

  it.each(LIBERADOS_NO_LAB)('%s: liga e desliga na mesma chave da clínica, na conta do laboratório', async (which) => {
    for (const enabled of [true, false]) {
      const b = banco([LAB]);
      expect(await b.svc.setOperacionalToggle(LAB, which, enabled, true)).toEqual({ ok: true, which, enabled });
      expect(b.ops).toEqual(opsEsperadas(which, enabled, LAB));
    }
  });

  it('aniversário ligado no laboratório: só a mensagem clássica (desejo e presente não são ligados por aqui)', async () => {
    const b = banco([LAB]);
    await b.svc.setOperacionalToggle(LAB, 'aniversario', true, true);
    expect(b.ops[1][1].create.value).toBe(JSON.stringify({ enabled: true }));
  });

  it('which que não existe, no laboratório: recusado como aviso que não existe', async () => {
    const b = banco([LAB]);
    const e = await erro(b.svc.setOperacionalToggle(LAB, 'nao_existe', true, true));
    expect(recusa(e)).toEqual(['ForbiddenException', 403, { message: LAB_RECUSA_DISPAROS.escondido, code: 'VERTICAL_DENIED' }]);
    expect(b.ops).toEqual([]);
  });
});

// ─── Textos de cobrança da Central ───────────────────────────────────────────

const chaveDoTexto = (stage: string, conta: string) => `COBRANCA_TEMPLATE_${stage.toUpperCase()}_${conta}`;
const salvo = (texto: string | null) => ({
  'globalSetting.findUnique': () => (texto ? { value: JSON.stringify({ template: texto }) } : null),
});

describe('textos de cobrança — clínica (lab = false): como em 9eb61bff', () => {
  const STAGES = ['negociacao_aprovada', 'negociacao_aprovada_avista', 'confirmacao_pagamento', 'boleto_1d_antes', 'pix_delivery', 'comprovante_pagamento', 'boleto_intro'];

  it.each(STAGES)('%s: o padrão da clínica, o texto salvo (mesmo com palavra de clínica) e a gravação', async (stage) => {
    for (const lab of [undefined, false]) {
      const nada = banco([LAB], salvo(null));
      expect(await nada.svc.getCobrancaTemplate(CLINICA, stage, undefined, lab)).toEqual({ template: defaultFinTemplate(stage) });
      expect(nada.ops).toEqual([F(chaveDoTexto(stage, CLINICA))]);

      for (const texto of ['Texto salvo da clínica {nome}.', 'Olá {nome}, seu tratamento com o paciente.']) {
        const com = banco([LAB], salvo(texto));
        expect(await com.svc.getCobrancaTemplate(CLINICA, stage, undefined, lab)).toEqual({ template: texto });
        expect(com.ops).toEqual([F(chaveDoTexto(stage, CLINICA))]);
      }

      const grava = banco([LAB]);
      expect(await grava.svc.setCobrancaTemplate(CLINICA, stage, 'Novo texto {nome}.', undefined, lab)).toEqual({ template: defaultFinTemplate(stage) });
      expect(grava.ops).toEqual([
        U(chaveDoTexto(stage, CLINICA), JSON.stringify({ template: 'Novo texto {nome}.' })),
        F(chaveDoTexto(stage, CLINICA)),
      ]);
      expect(nada.perfis).not.toHaveBeenCalled();
      expect(grava.perfis).not.toHaveBeenCalled();
    }
  });

  it('estágio que não existe: o mesmo 400 de antes', async () => {
    const b = banco();
    const e = await erro(b.svc.getCobrancaTemplate(CLINICA, 'xyz'));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('estágio inválido: xyz');
    const s = await erro(b.svc.setCobrancaTemplate(CLINICA, 'xyz', 'Novo texto {nome}.'));
    expect(s.message).toBe('estágio inválido: xyz');
    expect(b.ops).toEqual([]);
  });
});

describe('textos de cobrança — laboratório (lab = true)', () => {
  it('padrão do laboratório: orçamento aprovado (parcelado e à vista) e a confirmação de pagamento neutra', async () => {
    const padroes: Record<string, string> = {
      negociacao_aprovada: LAB_NEGOCIACAO.parcelado,
      negociacao_aprovada_avista: LAB_NEGOCIACAO.avista,
      confirmacao_pagamento: DEFAULT_CONFIRMACAO_PAGAMENTO,
    };
    for (const [stage, padrao] of Object.entries(padroes)) {
      const b = banco([LAB], salvo(null));
      expect(await b.svc.getCobrancaTemplate(LAB, stage, undefined, true)).toEqual({ template: padrao });
      expect(b.ops).toEqual([F(chaveDoTexto(stage, LAB))]);
    }
    expect(LAB_NEGOCIACAO.parcelado).not.toMatch(/tratamento|paciente/i);
  });

  it('texto salvo sem palavra de clínica: vale; com palavra de clínica: mostra o padrão (é o que sai)', async () => {
    const proprio = banco([LAB], salvo('Oi {nome}! Seu orçamento foi aprovado. {itens}'));
    expect(await proprio.svc.getCobrancaTemplate(LAB, 'negociacao_aprovada', undefined, true)).toEqual({
      template: 'Oi {nome}! Seu orçamento foi aprovado. {itens}',
    });
    const deClinica = banco([LAB], salvo('Olá {nome}, seu tratamento foi aprovado.'));
    expect(await deClinica.svc.getCobrancaTemplate(LAB, 'negociacao_aprovada_avista', undefined, true)).toEqual({
      template: LAB_NEGOCIACAO.avista,
    });
  });

  it.each(['pix_delivery', 'comprovante_pagamento', 'xyz'])(
    '%s: texto que não é editável no laboratório (ler e gravar recusados, nada lido nem gravado)',
    async (stage) => {
      const b = banco([LAB]);
      const g = await erro(b.svc.getCobrancaTemplate(LAB, stage, undefined, true));
      expect([g?.constructor?.name, g.getStatus(), g.getResponse()]).toEqual([
        'ForbiddenException',
        403,
        { message: LAB_RECUSA_DISPAROS.template, code: 'VERTICAL_DENIED' },
      ]);
      const s = await erro(b.svc.setCobrancaTemplate(LAB, stage, 'Novo texto {nome}.', undefined, true));
      expect(s.getResponse()).toEqual({ message: LAB_RECUSA_DISPAROS.template, code: 'VERTICAL_DENIED' });
      expect(b.ops).toEqual([]);
    },
  );

  it.each(COBRANCA_STAGES)('%s: o editor abre com o padrão do laboratório de cada tipo, na chave do tipo', async (stage) => {
    for (const tipo of COBRANCA_TIPOS) {
      const b = banco([LAB], salvo(null));
      expect(await b.svc.getCobrancaTemplate(LAB, stage, tipo, true)).toEqual({ template: padraoFinDoLaboratorio(stage, tipo) });
      expect(b.ops.map(([, a]) => a.where.key)).toEqual([
        `COBRANCA_TEMPLATE_${stage.toUpperCase()}_${tipo.toUpperCase()}_${LAB}`,
        chaveDoTexto(stage, LAB),
      ]);
    }
    // Texto com palavra de clínica: o editor mostra o padrão do tipo, que é o que sai.
    const deClinica = banco([LAB], salvo('Olá {nome}, seu tratamento está em aberto.'));
    expect(await deClinica.svc.getCobrancaTemplate(LAB, stage, 'pix', true)).toEqual({ template: padraoFinDoLaboratorio(stage, 'pix') });
  });

  it.each(['boleto_intro', 'boleto_delivery'])('%s: padrão do laboratório, texto próprio vale, texto de clínica não', async (stage) => {
    const padrao = banco([LAB], salvo(null));
    expect(await padrao.svc.getCobrancaTemplate(LAB, stage, undefined, true)).toEqual({ template: padraoFinDoLaboratorio(stage) });
    const proprio = banco([LAB], salvo('Oi {nome}, aqui é {clinica}.'));
    expect(await proprio.svc.getCobrancaTemplate(LAB, stage, undefined, true)).toEqual({ template: 'Oi {nome}, aqui é {clinica}.' });
    const deClinica = banco([LAB], salvo('Oi {nome}, sua consulta foi paga.'));
    expect(await deClinica.svc.getCobrancaTemplate(LAB, stage, undefined, true)).toEqual({ template: padraoFinDoLaboratorio(stage) });
  });

  it('gravar um texto da lista: a mesma chave da clínica, na conta do laboratório, e devolve o que sai', async () => {
    const b = banco([LAB]);
    expect(await b.svc.setCobrancaTemplate(LAB, 'negociacao_aprovada', 'Oi {nome}! Aprovado: {itens}', undefined, true)).toEqual({
      template: LAB_NEGOCIACAO.parcelado,
    });
    expect(b.ops).toEqual([
      U(chaveDoTexto('negociacao_aprovada', LAB), JSON.stringify({ template: 'Oi {nome}! Aprovado: {itens}' })),
      F(chaveDoTexto('negociacao_aprovada', LAB)),
    ]);
  });
});

// ─── Controller: quem decide é pedidoDeLaboratorio(req.user) ─────────────────

describe('FollowupController — passa a conta do pedido (laboratório ou clínica) como último argumento', () => {
  function montar() {
    const svc = {
      setOperacionalToggle: jest.fn(async () => ({ ok: true })),
      getCobrancaTemplate: jest.fn(async () => ({ template: '' })),
      setCobrancaTemplate: jest.fn(async () => ({ template: '' })),
    };
    return { svc, ctrl: new FollowupController(svc as any) };
  }
  const ADMIN_LAB = { user: { tenant_id: LAB, roles: ['ADMIN'], bt: 'LABORATORIO' } };
  const ADMIN_CLINICA = { user: { tenant_id: CLINICA, roles: ['ADMIN'] } };

  it('laboratório (claim do token): true nos três', async () => {
    const m = montar();
    await m.ctrl.setOperacionalToggle({ which: 'confirmacao', enabled: true }, ADMIN_LAB);
    await m.ctrl.getCobrancaTemplate('negociacao_aprovada', undefined, ADMIN_LAB);
    await m.ctrl.setCobrancaTemplate('negociacao_aprovada', undefined, { template: 'x' }, ADMIN_LAB);
    expect(m.svc.setOperacionalToggle.mock.calls).toEqual([[LAB, 'confirmacao', true, true]]);
    expect(m.svc.getCobrancaTemplate.mock.calls).toEqual([[LAB, 'negociacao_aprovada', undefined, true]]);
    expect(m.svc.setCobrancaTemplate.mock.calls).toEqual([[LAB, 'negociacao_aprovada', 'x', undefined, true]]);
  });

  it('a leitura dos cards leva o mesmo sinal: true no laboratório, false na clínica', async () => {
    const m = montar();
    (m.svc as any).getOperacional = jest.fn(async () => ({}));
    await (m.ctrl as any).getOperacional(ADMIN_LAB);
    await (m.ctrl as any).getOperacional(ADMIN_CLINICA);
    expect((m.svc as any).getOperacional.mock.calls).toEqual([[LAB, true], [CLINICA, false]]);
  });

  it('laboratório sem o claim (token antigo): vale a lista em cache', async () => {
    const b = banco([LAB]);
    await getLabTenantIds(b.prisma, () => undefined);
    const m = montar();
    await m.ctrl.setOperacionalToggle({ which: 'lembrete', enabled: false }, { user: { tenant_id: LAB, roles: ['ADMIN'] } });
    expect(m.svc.setOperacionalToggle.mock.calls).toEqual([[LAB, 'lembrete', false, true]]);
  });

  it('clínica (com e sem OUTRA conta laboratório no cache): false nos três, os mesmos argumentos de antes', async () => {
    for (const labs of [[], [LAB]]) {
      const b = banco(labs);
      if (labs.length) await getLabTenantIds(b.prisma, () => undefined);
      const m = montar();
      await m.ctrl.setOperacionalToggle({ which: 'pos', enabled: true }, ADMIN_CLINICA);
      await m.ctrl.getCobrancaTemplate('boleto_1d_antes', 'pix', ADMIN_CLINICA);
      await m.ctrl.setCobrancaTemplate('boleto_1d_antes', 'pix', {}, ADMIN_CLINICA);
      expect(m.svc.setOperacionalToggle.mock.calls).toEqual([[CLINICA, 'pos', true, false]]);
      expect(m.svc.getCobrancaTemplate.mock.calls).toEqual([[CLINICA, 'boleto_1d_antes', 'pix', false]]);
      expect(m.svc.setCobrancaTemplate.mock.calls).toEqual([[CLINICA, 'boleto_1d_antes', '', 'pix', false]]);
    }
  });

  it('quem não é ADMIN continua recebendo o 403 de antes, sem chegar ao serviço', async () => {
    const m = montar();
    const req = { user: { tenant_id: LAB, roles: ['ATENDENTE'], bt: 'LABORATORIO' } };
    expect(() => m.ctrl.setOperacionalToggle({ which: 'confirmacao', enabled: true }, req)).toThrow('Apenas ADMIN pode ligar/desligar as automações');
    expect(() => m.ctrl.setCobrancaTemplate('negociacao_aprovada', undefined, {}, req)).toThrow('Apenas ADMIN pode editar as mensagens de cobrança');
    expect(m.svc.setOperacionalToggle).not.toHaveBeenCalled();
    expect(m.svc.setCobrancaTemplate).not.toHaveBeenCalled();
  });
});
