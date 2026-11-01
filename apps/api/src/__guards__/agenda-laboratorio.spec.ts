/**
 * F7 do laboratório — o contrato da agenda de coleta, prova e entrega e da Central de
 * Disparos do laboratório (packages/shared/src/agenda-laboratorio.ts e lab-disparos.ts),
 * a validação do corpo da agenda (calendar.dto.ts) e as funções da API que decidem a
 * conta do pedido (agenda-do-laboratorio.ts e pedido-de-laboratorio.ts).
 *
 * CLÍNICA: o 400 de tipo inválido sai com o MESMO corpo de antes (inclusive para
 * COLETA, PROVA e ENTREGA), e nenhum texto padrão da clínica muda.
 * LABORATÓRIO: os tipos novos passam pela validação; a lista permitida da Central e
 * as recusas batem com os nomes reais do código (cards do web e o switch do servidor).
 *
 * O spec lê o @crm/shared COMPILADO (dist): depois de mexer no shared, rode
 * `npm run build -w @crm/shared` antes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ForbiddenException, HttpException, ValidationPipe } from '@nestjs/common';
import { IsIn, IsString, validate } from 'class-validator';
import * as shared from '@crm/shared';
import {
  ANTECEDENCIAS_DO_LABORATORIO,
  BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO,
  DEFAULT_BIRTHDAY_GREETING,
  DEFAULT_CONFIRMACAO_PAGAMENTO,
  DEFAULT_DENTIST_DAILY_SUMMARY,
  DEFAULT_REMINDER_CONFIG,
  DENTIST_DAILY_SUMMARY_PADRAO_DO_LABORATORIO,
  DISPAROS_VISIVEIS_NO_LABORATORIO,
  LAB_AGENDA_TEXTOS,
  LAB_NEGOCIACAO,
  LAB_RECUSA_DISPAROS,
  REGUA_DO_LABORATORIO,
  REMINDER_CONFIG_PADRAO_DO_LABORATORIO,
  TEMPLATES_FIN_DO_LABORATORIO,
  TESTES_DO_LABORATORIO,
  TIPOS_AVISO_LAB,
  TIPOS_DE_AGENDA_DA_CLINICA,
  TIPOS_DE_AGENDA_DO_LABORATORIO,
  TIPOS_SO_DO_LABORATORIO,
  TODOS_OS_TIPOS_DE_AGENDA,
  TOGGLES_DA_REGUA_NO_LABORATORIO,
  TOGGLES_DO_LABORATORIO,
  __limparCacheLabTenants,
  aplicarTextoDoLaboratorio,
  applyTemplate,
  chaveDoLembreteDoLaboratorio,
  dataCurtaNaive,
  enderecoDoCliente,
  getLabTenantIds,
  horaCurtaNaive,
  isFinTemplateId,
  lembreteDoLaboratorio,
  padraoFinDoLaboratorio,
  primeiroNomeSemTitulo,
  recusaDoToggleNoLaboratorio,
  rotuloTipoDoLaboratorio,
  tipoSoDoLaboratorio,
} from '@crm/shared';
import { CreateEventDto, MSG_TIPO_DTO, UpdateEventDto } from '../calendar/dto/calendar.dto';
import { TIPOS_CLINICOS } from '../calendar/agenda-status-guard';
import {
  TIPOS_DE_AGENDA_DO_LABORATORIO as TIPOS_DA_API,
  exigirTipoDaConta,
  tipoDeAgendaDoLaboratorio,
} from '../business-type/agenda-do-laboratorio';
import { TIPOS_DE_AGENDA_DO_LABORATORIO as TIPOS_DA_VIGIA } from '../business-type/lab-sentinela';
import { pedidoDeLaboratorio, recusarNoLaboratorio } from '../business-type/pedido-de-laboratorio';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';

const SRC = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SRC, '..', '..', '..');
const ler = (relativo: string) => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');

/** As strings entre aspas simples de um trecho de código. */
const strings = (trecho: string) => [...trecho.matchAll(/'([^']*)'/g)].map((m) => m[1]);

/** A lista `NOME = [...]` (ou `NOME = [...] as const`) lida do fonte. */
function listaDoFonte(relativo: string, nome: string): string[] {
  const m = new RegExp(`\\b${nome}\\s*=\\s*\\[([^\\]]*)\\]`).exec(ler(relativo));
  if (!m) throw new Error(`não achei ${nome} em ${relativo}`);
  return strings(m[1]);
}

const LAB_TIPOS = ['COLETA', 'PROVA', 'ENTREGA'];

// ─── Tipos da agenda ─────────────────────────────────────────────────────────

describe('Tipos da agenda — os da clínica ficam iguais; os do laboratório são só dele', () => {
  it('TIPOS_DE_AGENDA_DA_CLINICA é a lista do serviço da agenda, na mesma ordem', () => {
    expect([...TIPOS_DE_AGENDA_DA_CLINICA]).toEqual(listaDoFonte('apps/api/src/calendar/calendar.service.ts', 'EVENT_TYPES'));
    expect([...TIPOS_DE_AGENDA_DA_CLINICA]).toEqual([
      'CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA', 'BLOQUEIO', 'TAREFA', 'OUTRO', 'AUDIENCIA', 'PERICIA', 'PRAZO',
    ]);
  });

  it('listas do laboratório: só do laboratório, aceitas pela agenda dele, e todas juntas na validação do corpo', () => {
    expect([...TIPOS_SO_DO_LABORATORIO]).toEqual(LAB_TIPOS);
    expect(TIPOS_AVISO_LAB).toBe(TIPOS_SO_DO_LABORATORIO);
    expect([...TIPOS_DE_AGENDA_DO_LABORATORIO]).toEqual(['TAREFA', 'OUTRO', 'BLOQUEIO', ...LAB_TIPOS]);
    expect([...TODOS_OS_TIPOS_DE_AGENDA]).toEqual([...TIPOS_DE_AGENDA_DA_CLINICA, ...LAB_TIPOS]);
    for (const l of [TIPOS_DE_AGENDA_DA_CLINICA, TIPOS_SO_DO_LABORATORIO, TIPOS_DE_AGENDA_DO_LABORATORIO, TODOS_OS_TIPOS_DE_AGENDA, ANTECEDENCIAS_DO_LABORATORIO]) {
      expect(Object.isFrozen(l)).toBe(true);
    }
    expect(TIPOS_DE_AGENDA_DA_CLINICA.filter((t) => LAB_TIPOS.includes(t))).toEqual([]);
  });

  it('a API e a vigia usam a MESMA lista do shared', () => {
    expect(TIPOS_DA_API).toBe(TIPOS_DE_AGENDA_DO_LABORATORIO);
    expect(TIPOS_DA_VIGIA).toBe(TIPOS_DE_AGENDA_DO_LABORATORIO);
    for (const t of TIPOS_DE_AGENDA_DO_LABORATORIO) expect(tipoDeAgendaDoLaboratorio(t)).toBe(true);
    for (const t of ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA', 'AUDIENCIA', 'PERICIA', 'PRAZO', 'coleta', '', null, 1]) {
      expect(tipoDeAgendaDoLaboratorio(t)).toBe(false);
    }
  });

  it('tipoSoDoLaboratorio: só o valor exato', () => {
    for (const t of LAB_TIPOS) expect(tipoSoDoLaboratorio(t)).toBe(true);
    for (const t of ['coleta', 'COLETA ', 'TAREFA', 'CONSULTA', '', undefined, null, 1, {}, ['COLETA']]) {
      expect(tipoSoDoLaboratorio(t)).toBe(false);
    }
  });

  it('nenhuma lista de tipos de atendimento da clínica tem coleta, prova ou entrega', () => {
    const listas: Array<[string, readonly string[]]> = [
      ['TIPOS_CLINICOS', TIPOS_CLINICOS],
      ['quotes.service CLINICAL_TYPES', listaDoFonte('apps/api/src/commercial/quotes.service.ts', 'CLINICAL_TYPES')],
      ['game-rules CLINICAL_TYPES', listaDoFonte('apps/api/src/commissions/game-rules.ts', 'CLINICAL_TYPES')],
      ['clinic-transfer-guard CLINICAL_TYPES', listaDoFonte('apps/api/src/leads/clinic-transfer-guard.ts', 'CLINICAL_TYPES')],
      ['dentist-links CLINICAL_TYPES', listaDoFonte('apps/api/src/patients/dentist-links.ts', 'CLINICAL_TYPES')],
      ['worker ADMIN_AGENDAMENTO_TIPOS', listaDoFonte('apps/worker/src/admin-alerts/admin-agendamento-regras.ts', 'ADMIN_AGENDAMENTO_TIPOS')],
    ];
    for (const [nome, lista] of listas) {
      expect([nome, lista.length > 0]).toEqual([nome, true]);
      expect([nome, lista.filter((t) => LAB_TIPOS.includes(t))]).toEqual([nome, []]);
    }
  });
});

// ─── Validação do corpo da agenda ────────────────────────────────────────────

/** O corpo da agenda como era antes dos tipos do laboratório (só a lista da clínica). */
class CorpoDeAntes {
  @IsIn([...TIPOS_DE_AGENDA_DA_CLINICA])
  type!: string;

  @IsString()
  title!: string;

  @IsString()
  start_at!: string;
}

const pipe = () => new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

async function respostaDoPipe(corpo: unknown, metatype: any): Promise<unknown> {
  try {
    await pipe().transform(corpo, { type: 'body', metatype });
    return 'passou';
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as HttpException).getResponse();
  }
}

function respostaDe(fn: () => void): unknown {
  try {
    fn();
    return 'passou';
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as HttpException).getResponse();
  }
}

describe('Validação do corpo da agenda — o 400 da clínica não muda', () => {
  const corpo = (type: string) => ({ type, title: 'Visita', start_at: '2026-11-03T14:00:00.000Z' });

  it('MSG_TIPO_DTO é exatamente a mensagem que a validação gera com a lista da clínica', async () => {
    const x = Object.assign(new CorpoDeAntes(), corpo('XYZ'));
    const [erro] = await validate(x);
    expect(erro.constraints).toEqual({ isIn: MSG_TIPO_DTO });
    expect(MSG_TIPO_DTO).toBe(`type must be one of the following values: ${TIPOS_DE_AGENDA_DA_CLINICA.join(', ')}`);
  });

  it.each(['XYZ', 'consulta', '', 'AVALIACAO'])('tipo %p inválido: o MESMO corpo de antes (criar e editar)', async (tipo) => {
    const antes = await respostaDoPipe(corpo(tipo), CorpoDeAntes);
    expect(antes).toEqual({ message: [MSG_TIPO_DTO], error: 'Bad Request', statusCode: 400 });
    expect(await respostaDoPipe(corpo(tipo), CreateEventDto)).toEqual(antes);
    expect(await respostaDoPipe({ type: tipo }, UpdateEventDto)).toEqual(antes);
  });

  it.each(LAB_TIPOS)('%s: a validação do corpo aceita (criar e editar); a conta decide depois', async (tipo) => {
    expect(await respostaDoPipe(corpo(tipo), CreateEventDto)).toBe('passou');
    expect(await respostaDoPipe({ type: tipo }, UpdateEventDto)).toBe('passou');
  });

  it.each(LAB_TIPOS)('%s numa conta de CLÍNICA: exigirTipoDaConta dá o MESMO corpo que a validação dava antes', async (tipo) => {
    const antes = await respostaDoPipe(corpo(tipo), CorpoDeAntes);
    expect(antes).toEqual({ message: [MSG_TIPO_DTO], error: 'Bad Request', statusCode: 400 });
    expect(respostaDe(() => exigirTipoDaConta(false, tipo))).toEqual(antes);
  });

  it('exigirTipoDaConta deixa passar o laboratório e os tipos da clínica (quem decide é o serviço)', () => {
    for (const tipo of LAB_TIPOS) expect(respostaDe(() => exigirTipoDaConta(true, tipo))).toBe('passou');
    for (const tipo of [...TIPOS_DE_AGENDA_DA_CLINICA, undefined, null, '', 'XYZ']) {
      expect(respostaDe(() => exigirTipoDaConta(false, tipo))).toBe('passou');
      expect(respostaDe(() => exigirTipoDaConta(true, tipo))).toBe('passou');
    }
  });

  it('os tipos da clínica continuam aceitos pela validação, como antes', async () => {
    for (const tipo of TIPOS_DE_AGENDA_DA_CLINICA) {
      expect(await respostaDoPipe(corpo(tipo), CorpoDeAntes)).toBe('passou');
      expect(await respostaDoPipe(corpo(tipo), CreateEventDto)).toBe('passou');
    }
  });
});

// ─── Regras puras da agenda do laboratório ───────────────────────────────────

describe('Agenda do laboratório — regras puras', () => {
  it('lembreteDoLaboratorio: PUSH sempre; WhatsApp só 48 h e 24 h; e-mail e o resto nunca', () => {
    const doCriar = lembreteDoLaboratorio('PUSH');
    const doEditar = lembreteDoLaboratorio('WHATSAPP');
    expect(doCriar({ minutes_before: 30, channel: 'PUSH' })).toBe(true);
    expect(doCriar({ minutes_before: 30 })).toBe(true); // sem canal: PUSH
    expect(doEditar({ minutes_before: 30 })).toBe(false); // sem canal: WHATSAPP de 30 min
    for (const min of [2880, 1440]) {
      expect(doCriar({ minutes_before: min, channel: 'WHATSAPP' })).toBe(true);
      expect(doEditar({ minutes_before: min })).toBe(true);
    }
    for (const min of [60, 15, 4320, 0]) expect(doCriar({ minutes_before: min, channel: 'WHATSAPP' })).toBe(false);
    for (const min of [2880, 1440, 60]) {
      expect(doCriar({ minutes_before: min, channel: 'EMAIL' })).toBe(false);
      expect(doCriar({ minutes_before: min, channel: 'SMS' })).toBe(false);
    }
    expect([...ANTECEDENCIAS_DO_LABORATORIO]).toEqual([2880, 1440]);
  });

  it.each<[string | null | undefined, string]>([
    ['Dra. Ana Souza', 'Ana'],
    ['Dr. João Silva', 'João'],
    ['DRA Maria', 'Maria'],
    ['dr.Pedro', 'Pedro'],
    ['Drª Carla Lima', 'Carla'],
    ['Doutora Beatriz', 'Beatriz'],
    ['Doutor Paulo Exemplo', 'Paulo'],
    ['  Clínica Sorriso Exemplo  ', 'Clínica'],
    ['Drauzio Exemplo', 'Drauzio'],
    ['Dra.', ''],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('primeiroNomeSemTitulo(%p) = %p', (nome, esperado) => {
    expect(primeiroNomeSemTitulo(nome)).toBe(esperado);
  });

  it('data e hora curtas da agenda naive-UTC (getUTC*)', () => {
    expect(dataCurtaNaive('2026-11-03T14:30:00.000Z')).toBe('03/11');
    expect(horaCurtaNaive('2026-11-03T14:30:00.000Z')).toBe('14:30');
    expect(dataCurtaNaive(new Date('2026-01-09T09:05:00.000Z'))).toBe('09/01');
    expect(horaCurtaNaive(new Date('2026-01-09T09:05:00.000Z'))).toBe('09:05');
    for (const ruim of ['', 'x', null, undefined]) {
      expect(dataCurtaNaive(ruim as any)).toBe('');
      expect(horaCurtaNaive(ruim as any)).toBe('');
    }
  });

  it('endereço da visita: o local do evento; sem ele, o do cadastro do cliente; sem nada, vazio', () => {
    const cadastro = { address: 'Rua Exemplo', address_number: '10', neighborhood: 'Centro', city: 'Maceió', state: 'AL' };
    expect(enderecoDoCliente('  Sala 3 do consultório  ', cadastro)).toBe('Sala 3 do consultório');
    expect(enderecoDoCliente('', cadastro)).toBe('Rua Exemplo, 10, Centro, Maceió/AL');
    expect(enderecoDoCliente(null, cadastro)).toBe('Rua Exemplo, 10, Centro, Maceió/AL');
    expect(enderecoDoCliente(undefined, null)).toBe('');
  });

  it('rótulo do tipo', () => {
    expect(['COLETA', 'PROVA', 'ENTREGA'].map(rotuloTipoDoLaboratorio)).toEqual(['Coleta', 'Prova', 'Entrega']);
    expect(rotuloTipoDoLaboratorio('OUTRO')).toBe('OUTRO');
    expect(rotuloTipoDoLaboratorio('toString')).toBe('toString');
    expect(rotuloTipoDoLaboratorio(null)).toBe('');
  });

  it('aplicarTextoDoLaboratorio: saída exata (aviso na hora, com endereço)', () => {
    const msg = aplicarTextoDoLaboratorio(LAB_AGENDA_TEXTOS.avisoAgendado, {
      nomeDoCliente: 'Dra. Ana Souza',
      tipo: 'COLETA',
      inicio: '2026-11-03T14:30:00.000Z',
      local: 'Rua Exemplo, 10, Centro, Maceió/AL',
      laboratorio: 'Laboratório Exemplo',
    });
    expect(msg).toBe(
      'Olá Ana! Agendamos a *coleta* do seu trabalho para *03/11* às *14:30*.\n' +
        '📍 Rua Exemplo, 10, Centro, Maceió/AL\n\n' +
        'Qualquer dúvida, é só chamar por aqui.',
    );
  });

  it('aplicarTextoDoLaboratorio: sem endereço a linha some; sem nome vale o padrão', () => {
    expect(aplicarTextoDoLaboratorio(LAB_AGENDA_TEXTOS.lembrete24h, { nomeDoCliente: '', tipo: 'PROVA', inicio: '2026-11-03T09:05:00.000Z' })).toBe(
      'Oi doutor(a)! Lembrete do laboratório: amanhã, *03/11* às *09:05*, passamos no consultório para a prova do seu trabalho.',
    );
    expect(aplicarTextoDoLaboratorio(LAB_AGENDA_TEXTOS.lembrete48h, { nomeDoCliente: 'Dr. Carlos Lima', tipo: 'ENTREGA', inicio: '2026-11-03T09:05:00.000Z' })).toBe(
      'Oi Carlos! Lembrete do laboratório: *03/11* às *09:05* passamos no consultório para a entrega do seu trabalho.\n\n' +
        'Se precisar mudar, é só responder aqui.',
    );
  });

  it('aplicarTextoDoLaboratorio: {tipo}, {protetico}, {clinica}, {dentista} e {nome_completo}', () => {
    const tpl = 'A {tipo} com {protetico} — {clinica} — {dentista} — {nome_completo} — {x}';
    expect(aplicarTextoDoLaboratorio(tpl, { nomeDoCliente: 'Dr. Carlos Lima', tipo: 'ENTREGA', protetico: 'Pedro' })).toBe(
      'A entrega com Pedro — nosso laboratório — Dr. Carlos Lima — Dr. Carlos Lima —',
    );
    expect(aplicarTextoDoLaboratorio('{clinica}: {tipo}.', { tipo: 'OUTRO', laboratorio: 'Laboratório Exemplo' })).toBe('Laboratório Exemplo: .');
    // Troca com função: $& no nome não vira padrão de substituição.
    expect(aplicarTextoDoLaboratorio('{protetico}', { protetico: 'R$& Teste' })).toBe('R$& Teste');
  });

  it('chave do texto do lembrete: 48 h ou mais = consulta_confirmacao; menos = consulta_24h', () => {
    expect(chaveDoLembreteDoLaboratorio(2880)).toBe('consulta_confirmacao');
    expect(chaveDoLembreteDoLaboratorio(4320)).toBe('consulta_confirmacao');
    expect(chaveDoLembreteDoLaboratorio(1440)).toBe('consulta_24h');
  });

  it('padrões do laboratório: lembretes 48 h/24 h ligados; resumo e aniversário com texto do laboratório e desligados', () => {
    expect(REMINDER_CONFIG_PADRAO_DO_LABORATORIO).toEqual({
      enabled: true,
      default_antecedencias: [
        { minutes_before: 2880, channel: 'WHATSAPP' },
        { minutes_before: 1440, channel: 'WHATSAPP' },
      ],
      templates: {
        consulta_confirmacao: LAB_AGENDA_TEXTOS.lembrete48h,
        consulta_24h: LAB_AGENDA_TEXTOS.lembrete24h,
        consulta_1h: '',
        consulta_15min: '',
      },
    });
    expect(DENTIST_DAILY_SUMMARY_PADRAO_DO_LABORATORIO).toEqual({ ...DEFAULT_DENTIST_DAILY_SUMMARY, template: LAB_AGENDA_TEXTOS.resumoProtetico });
    expect(DENTIST_DAILY_SUMMARY_PADRAO_DO_LABORATORIO.enabled).toBe(false);
    expect(BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO).toEqual({
      ...DEFAULT_BIRTHDAY_GREETING,
      template: LAB_AGENDA_TEXTOS.aniversario,
      message2_enabled: false,
      message2_template: '',
      message3_enabled: false,
      message3_template: '',
    });
    expect(BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO.enabled).toBe(false);
    // O padrão da clínica não foi tocado.
    expect(DEFAULT_REMINDER_CONFIG.default_antecedencias.map((a) => a.minutes_before)).toEqual([2880, 1440, 60, 15]);
    expect(REMINDER_CONFIG_PADRAO_DO_LABORATORIO.templates).not.toBe(DEFAULT_REMINDER_CONFIG.templates);
  });
});

// ─── A clínica não muda ──────────────────────────────────────────────────────

/** Todas as strings (em qualquer profundidade) de um valor. */
function todasAsStrings(v: unknown, saida: string[] = [], vistos = new Set<unknown>()): string[] {
  if (typeof v === 'string') saida.push(v);
  else if (v && typeof v === 'object' && !vistos.has(v)) {
    vistos.add(v);
    for (const x of Object.values(v as Record<string, unknown>)) todasAsStrings(x, saida, vistos);
  }
  return saida;
}

describe('Textos padrão da clínica — sem a variável do laboratório e com o mesmo resultado', () => {
  const padroesDaClinica = Object.entries(shared as Record<string, unknown>).filter(([nome]) => nome.startsWith('DEFAULT_'));

  it('nenhum texto padrão DEFAULT_* do shared usa {tipo} ou {protetico}', () => {
    expect(padroesDaClinica.length).toBeGreaterThan(5);
    const comVariavelDoLab = padroesDaClinica.flatMap(([nome, v]) =>
      todasAsStrings(v).filter((t) => t.includes('{tipo}') || t.includes('{protetico}')).map(() => nome),
    );
    expect(comVariavelDoLab).toEqual([]);
  });

  it('applyTemplate da clínica dá o mesmo resultado com e sem a variável tipo', () => {
    const vars = {
      nome: 'Maria',
      nome_completo: 'Maria Exemplo',
      dentista: 'Dra. Exemplo',
      dentista_completo: 'Dra. Exemplo Silva',
      data: '03/11',
      hora: '14:30',
      local: 'Rua Exemplo, 10',
      clinica: 'Clínica Exemplo',
      antecedencia: '1 dia',
    };
    const textos = padroesDaClinica.flatMap(([, v]) => todasAsStrings(v)).filter((t) => /\{\w+\}/.test(t));
    expect(textos.length).toBeGreaterThan(5);
    for (const t of textos) expect(applyTemplate(t, { ...vars, tipo: 'coleta' } as any)).toBe(applyTemplate(t, vars));
  });
});

// ─── Conta do pedido e recusa da Central ─────────────────────────────────────

describe('pedidoDeLaboratorio e recusarNoLaboratorio', () => {
  afterEach(() => __limparCacheLabTenants());

  it('pelo claim do token ou pela lista de laboratórios já carregada; o resto é clínica', async () => {
    __limparCacheLabTenants();
    expect(pedidoDeLaboratorio({ bt: 'LABORATORIO', tenant_id: 't-x' })).toBe(true);
    for (const u of [undefined, null, {}, { tenant_id: 't-lab' }, { bt: 'laboratorio', tenant_id: 't-lab' }, { bt: 'CLINICA' }]) {
      expect(pedidoDeLaboratorio(u as any)).toBe(false);
    }
    await getLabTenantIds({ tenantBusinessProfile: { findMany: async () => [{ tenant_id: 't-lab' }] } });
    expect(pedidoDeLaboratorio({ tenant_id: 't-lab' })).toBe(true);
    expect(pedidoDeLaboratorio({ tenant_id: 't-clinica' })).toBe(false);
    expect(pedidoDeLaboratorio({ tenant_id: null })).toBe(false);
  });

  it('recusa: 403 com o texto do motivo e o código da recusa de vertical', () => {
    for (const motivo of ['escondido', 'regua', 'antecedencia', 'aniversario', 'template', 'teste'] as const) {
      const e = recusarNoLaboratorio(motivo);
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.getStatus()).toBe(403);
      expect(e.getResponse()).toEqual({ message: LAB_RECUSA_DISPAROS[motivo], code: CODIGO_VERTICAL_NEGADA });
    }
  });
});

// ─── Central de Disparos do laboratório ──────────────────────────────────────

/** Cards do catálogo do web: id → texto do card (até o próximo id). */
function cardsDoWeb(): Map<string, string> {
  const src = ler('apps/web/src/app/atendimento/settings/disparos/disparos.config.ts');
  const inicio = src.indexOf('export const DISPAROS');
  expect(inicio).toBeGreaterThan(0);
  const corpo = src.slice(inicio);
  const marcas = [...corpo.matchAll(/\{ id: '(\w+)'/g)];
  const cards = new Map<string, string>();
  marcas.forEach((m, i) => cards.set(m[1], corpo.slice(m.index!, marcas[i + 1]?.index ?? corpo.length)));
  return cards;
}

/** Os `case '...'` do switch de setOperacionalToggle (followup.service.ts). */
function casosDoToggle(): string[] {
  const src = ler('apps/api/src/followup/followup.service.ts');
  const ini = src.indexOf('async setOperacionalToggle(');
  const fim = src.indexOf('default: {', ini);
  expect(ini).toBeGreaterThan(0);
  expect(fim).toBeGreaterThan(ini);
  return [...src.slice(ini, fim).matchAll(/case '(\w+)':/g)].map((m) => m[1]);
}

describe('Central de Disparos do laboratório — lista permitida e recusas', () => {
  const ESCONDIDOS = [
    'comprovante_pagamento',
    'pix_delivery',
    'nps',
    'recall_preventivo',
    'task_alerts',
    'admin_agendamento_ia',
    'nao_paciente_triage',
    'lembrete_1h',
    'lembrete_15min',
    'lembrete_audio_teste',
    'aniversario_desejo',
    'aniversario_presente',
    'orto_ordem_chegada',
    'confirmacao_orto_imediata',
    'confirmacao_orto',
    'lembrete_orto_1h',
    'pacientes_sem_agendamento',
    'pacientes_sem_agendamento_orto',
    'followup_lead',
    'comercial_confirmacao',
    'reativacao_leads',
  ];

  it('23 cards, todos existentes no catálogo do web; os escondidos ficam de fora', () => {
    const cards = cardsDoWeb();
    expect(DISPAROS_VISIVEIS_NO_LABORATORIO.size).toBe(23);
    expect([...DISPAROS_VISIVEIS_NO_LABORATORIO].filter((id) => !cards.has(id))).toEqual([]);
    for (const id of ESCONDIDOS) expect([id, DISPAROS_VISIVEIS_NO_LABORATORIO.has(id)]).toEqual([id, false]);
    for (const id of DISPAROS_VISIVEIS_NO_LABORATORIO) {
      expect([id, /^(retorno_|reativacao_|comercial_)/.test(id)]).toEqual([id, false]);
      expect([id, /emBreve:\s*true/.test(cards.get(id)!)]).toEqual([id, false]);
    }
  });

  it('régua: 10 cards visíveis, e o liga/desliga de cada um é da régua', () => {
    const cards = cardsDoWeb();
    expect(REGUA_DO_LABORATORIO.size).toBe(10);
    for (const id of REGUA_DO_LABORATORIO) {
      expect(DISPAROS_VISIVEIS_NO_LABORATORIO.has(id)).toBe(true);
      const chave = /operacionalKey: '(\w+)'/.exec(cards.get(id)!)?.[1];
      expect([id, chave && TOGGLES_DA_REGUA_NO_LABORATORIO.has(chave)]).toEqual([id, true]);
    }
  });

  it('cada card visível liga e desliga por um caminho aceito no laboratório', () => {
    const cards = cardsDoWeb();
    for (const id of DISPAROS_VISIVEIS_NO_LABORATORIO) {
      const card = cards.get(id)!;
      const chave = /operacionalKey: '(\w+)'/.exec(card)?.[1];
      const antecedencia = /antecedenciaMin: (\d+)/.exec(card)?.[1];
      const aniversario = /birthdayMsg: (\d)/.exec(card)?.[1];
      if (chave) expect([id, TOGGLES_DO_LABORATORIO.has(chave) || TOGGLES_DA_REGUA_NO_LABORATORIO.has(chave)]).toEqual([id, true]);
      else if (antecedencia) expect([id, ANTECEDENCIAS_DO_LABORATORIO.includes(Number(antecedencia))]).toEqual([id, true]);
      else expect([id, aniversario]).toEqual([id, '1']);
    }
  });

  it('os nomes dos liga/desliga são os do switch do servidor (nome morto = o laboratório perdeu o card)', () => {
    const casos = new Set(casosDoToggle());
    expect([...TOGGLES_DO_LABORATORIO, ...TOGGLES_DA_REGUA_NO_LABORATORIO].filter((w) => !casos.has(w))).toEqual([]);
  });

  it('recusa do liga/desliga: régua só desliga; os permitidos passam; todo o resto é escondido', () => {
    for (const w of TOGGLES_DO_LABORATORIO) {
      expect(recusaDoToggleNoLaboratorio(w, true)).toBeNull();
      expect(recusaDoToggleNoLaboratorio(w, false)).toBeNull();
    }
    expect(TOGGLES_DA_REGUA_NO_LABORATORIO.size).toBe(10);
    for (const w of TOGGLES_DA_REGUA_NO_LABORATORIO) {
      expect(recusaDoToggleNoLaboratorio(w, true)).toBe('regua');
      expect(recusaDoToggleNoLaboratorio(w, false)).toBeNull();
    }
    const outros = casosDoToggle().filter((w) => !TOGGLES_DO_LABORATORIO.has(w) && !TOGGLES_DA_REGUA_NO_LABORATORIO.has(w));
    expect(outros).toEqual(
      expect.arrayContaining(['pos', 'recall_preventivo', 'task_alerts', 'comprovante_pagamento', 'pix_delivery', 'admin_agendamento_ia']),
    );
    for (const w of [...outros, 'comercial_confirmacao', 'reativacao_leads', 'retorno_limpeza_1', 'qualquer', '']) {
      expect([w, recusaDoToggleNoLaboratorio(w, true)]).toEqual([w, 'escondido']);
      expect([w, recusaDoToggleNoLaboratorio(w, false)]).toEqual([w, 'escondido']);
    }
  });

  it('textos de cobrança editáveis: os 3 da lista, com o padrão do laboratório', () => {
    expect([...TEMPLATES_FIN_DO_LABORATORIO]).toEqual(['negociacao_aprovada', 'negociacao_aprovada_avista', 'confirmacao_pagamento']);
    for (const s of TEMPLATES_FIN_DO_LABORATORIO) expect(isFinTemplateId(s)).toBe(true);
    expect(padraoFinDoLaboratorio('negociacao_aprovada')).toBe(LAB_NEGOCIACAO.parcelado);
    expect(padraoFinDoLaboratorio('negociacao_aprovada_avista')).toBe(LAB_NEGOCIACAO.avista);
    expect(padraoFinDoLaboratorio('confirmacao_pagamento')).toBe(DEFAULT_CONFIRMACAO_PAGAMENTO);
    for (const s of ['boleto_1d_antes', 'boleto_intro', 'pix_delivery', 'comprovante_pagamento', 'x']) expect(padraoFinDoLaboratorio(s)).toBeNull();
  });

  it('Testar: só avisos que existem no laboratório', () => {
    for (const id of TESTES_DO_LABORATORIO) {
      expect([id, ESCONDIDOS.includes(id) || REGUA_DO_LABORATORIO.has(id)]).toEqual([id, false]);
    }
    expect(TESTES_DO_LABORATORIO.has('resumo_dentista')).toBe(true);
  });
});
