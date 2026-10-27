/**
 * F3 do laboratório — o que a conta de laboratório recebe ao nascer
 * (packages/shared/src/lab-defaults.ts) e a invalidação da lista de
 * laboratórios (lab-tenants.ts). Prisma mockado (gravador de chamadas).
 */
import {
  AI_CHIP_PURPOSES,
  CATEGORIAS_FINANCEIRAS_DO_LABORATORIO,
  DEFAULT_PROCEDURES,
  DEFAULT_SPECIALTIES,
  FUNIL_CAPTACAO_DE_DENTISTAS,
  GRUPOS_DE_PROTESE,
  SERVICOS_DE_PROTESE,
  __limparCacheLabTenants,
  aiEnabledKey,
  aiProfileKey,
  chavesDesligadasDoLaboratorio,
  ensureLabDefaults,
  generalStageOf,
  getLabTenantIds,
  invalidarCacheLabTenants,
  isLabTenantCached,
  normalizeAiChipProfile,
  seedLabTenantDefaults,
} from '@crm/shared';

const LAB = '1abe1abe-0000-4000-8000-000000000001';

interface Chamada {
  op: string;
  args: any;
}

/** Prisma falso: grava `<model>.<método>(args)` e responde pelo mapa (padrão: null). */
function gravador(respostas: Record<string, (args: any) => any> = {}) {
  const chamadas: Chamada[] = [];
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        return new Proxy(
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
      },
    },
  );
  const de = (op: string) => chamadas.filter((c) => c.op === op).map((c) => c.args);
  return { prisma, chamadas, de };
}

// Vocabulário da clínica que não entra em texto de laboratório (o mesmo do
// scripts/ci/check-pick-literals.mjs) + "odontológico".
const PROIBIDOS = [
  /pacientes?/,
  /consultas?/,
  /prontuarios?/,
  /anamneses?/,
  /odontogramas?/,
  /planos? de tratamentos?/,
  /tratamentos? odontologicos?/,
  /tcle/,
  /odontolog\p{L}*/u,
];
const normalizar = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function textoDeClinica(t: string): string | null {
  const n = normalizar(t);
  return PROIBIDOS.find((re) => new RegExp(`(?<![\\p{L}\\p{N}])${re.source}(?![\\p{L}\\p{N}])`, 'u').test(n))?.source ?? null;
}

/** Todos os textos que o laboratório recebe (nomes, descrições, rótulos). */
function textosDoLaboratorio(): string[] {
  const f = FUNIL_CAPTACAO_DE_DENTISTAS;
  return [
    ...GRUPOS_DE_PROTESE.flatMap((g) => [g.name, g.description]),
    ...SERVICOS_DE_PROTESE.map((s) => s.name),
    ...CATEGORIAS_FINANCEIRAS_DO_LABORATORIO.map((c) => c.name),
    f.name,
    f.slug,
    f.description,
    ...f.stages.flatMap((s) => [s.name, s.slug, s.description]),
  ];
}

describe('lab-defaults — chaves desligadas da conta de laboratório', () => {
  it('GlobalSetting: toda chave termina com _<id do laboratório> (nada global)', () => {
    const { globaisDaConta } = chavesDesligadasDoLaboratorio(LAB);
    expect(globaisDaConta.length).toBeGreaterThan(0);
    for (const c of globaisDaConta) {
      expect(c.key.endsWith(`_${LAB}`)).toBe(true);
      expect(c.key.length).toBeGreaterThan(LAB.length + 1);
    }
    expect(new Set(globaisDaConta.map((c) => c.key)).size).toBe(globaisDaConta.length);
  });

  it('nomes reais das chaves que o código lê (por conta na GlobalSetting)', () => {
    const { globaisDaConta } = chavesDesligadasDoLaboratorio(LAB);
    const valor = Object.fromEntries(globaisDaConta.map((c) => [c.key.slice(0, -(LAB.length + 1)), c.value]));
    expect(Object.keys(valor).sort()).toEqual(
      [
        'RECALL_PREVENTIVO_ENABLED',
        'TASK_ALERTS_ENABLED',
        'REMINDER_CONFIG',
        'APPOINTMENT_CONFIRMATION_ENABLED',
        'APPOINTMENT_RESCHEDULED_ENABLED',
        'PAYMENT_CONFIRMATION_ENABLED',
        'BIRTHDAY_GREETING',
        'BOLETO_1D_ANTES',
        'BOLETO_NO_DIA',
        'BOLETO_ATRASO_1D',
        'BOLETO_ATRASO_2D',
        'BOLETO_ATRASO_3D',
        'BOLETO_ATRASO_15D',
        'BOLETO_ATRASO_30D',
        'BOLETO_ATRASADO',
        'BOLETO_INTRO_ENABLED',
        'BOLETO_DELIVERY_ENABLED',
        'COMMISSION_MISSIONS',
        'MEMORY_BATCH_ENABLED',
        'POST_CARE_CONFIG',
      ].sort(),
    );
    // Os liga/desliga em texto: só 'false'.
    for (const [k, v] of Object.entries(valor)) {
      if (!['REMINDER_CONFIG', 'BIRTHDAY_GREETING', 'COMMISSION_MISSIONS', 'POST_CARE_CONFIG'].includes(k)) expect(v).toBe('false');
    }
    // Os JSON: desligados como os leitores entendem (lembrete: enabled === false;
    // aniversário: as 3 mensagens; missões: enabled false e lista presente e vazia).
    expect(JSON.parse(valor.REMINDER_CONFIG)).toEqual({ enabled: false });
    expect(JSON.parse(valor.BIRTHDAY_GREETING)).toEqual({ enabled: false, message2_enabled: false, message3_enabled: false });
    expect(JSON.parse(valor.COMMISSION_MISSIONS)).toEqual({ enabled: false, missions: [] });
    // pós-atendimento: o leitor junta com o padrão ({...DEFAULT_CONFIG, ...salvo}), então enabled false desliga.
    expect(JSON.parse(valor.POST_CARE_CONFIG)).toEqual({ enabled: false });
  });

  it('TenantSetting (coluna tenant_id): IA dos 3 chips, fora do expediente e perfil sem 2ª tentativa de agendamento', () => {
    const { daConta } = chavesDesligadasDoLaboratorio(LAB);
    const valor = Object.fromEntries(daConta.map((c) => [c.key, c.value]));
    expect(Object.keys(valor).sort()).toEqual(
      [...AI_CHIP_PURPOSES.map(aiEnabledKey), 'AFTER_HOURS_AI_ENABLED', ...AI_CHIP_PURPOSES.map(aiProfileKey)].sort(),
    );
    for (const p of AI_CHIP_PURPOSES) {
      expect(valor[aiEnabledKey(p)]).toBe('false');
      expect(normalizeAiChipProfile(valor[aiProfileKey(p)]).schedulingRetryMin).toBe(0);
    }
    expect(valor.AFTER_HOURS_AI_ENABLED).toBe('false');
    // A conta vai na coluna; o nome da chave não leva o id.
    for (const c of daConta) expect(c.key.includes(LAB)).toBe(false);
  });

  it('nenhuma chave começa com o prefixo reservado a texto de laboratório', () => {
    const { daConta, globaisDaConta } = chavesDesligadasDoLaboratorio(LAB);
    for (const c of [...daConta, ...globaisDaConta]) expect(c.key.startsWith('LAB' + '_')).toBe(false);
  });

  it.each([undefined, null, '', '   ', 42])('sem conta (%p) não monta chave nenhuma', (id) => {
    expect(() => chavesDesligadasDoLaboratorio(id as any)).toThrow();
  });
});

describe('lab-defaults — ensureLabDefaults', () => {
  it('só createMany com skipDuplicates: grava o que falta, nunca atualiza nem apaga', async () => {
    const g = gravador({ 'tenantSetting.createMany': () => ({ count: 7 }), 'globalSetting.createMany': () => ({ count: 18 }) });
    const r = await ensureLabDefaults(g.prisma, LAB);

    expect(g.chamadas.map((c) => c.op)).toEqual(['tenantSetting.createMany', 'globalSetting.createMany']);
    expect(r).toEqual({ daConta: 7, globais: 18 });
    const [ts] = g.de('tenantSetting.createMany');
    const [gs] = g.de('globalSetting.createMany');
    expect(ts.skipDuplicates).toBe(true);
    expect(gs.skipDuplicates).toBe(true);
    for (const linha of ts.data) expect(linha.tenant_id).toBe(LAB);
    for (const linha of gs.data) {
      expect(linha.key.endsWith(`_${LAB}`)).toBe(true);
      expect(Object.keys(linha).sort()).toEqual(['key', 'value']);
    }
  });

  it('2ª execução (tudo já existe): nada gravado, nenhuma outra chamada', async () => {
    const g = gravador({ 'tenantSetting.createMany': () => ({ count: 0 }), 'globalSetting.createMany': () => ({ count: 0 }) });
    expect(await ensureLabDefaults(g.prisma, LAB)).toEqual({ daConta: 0, globais: 0 });
    expect(g.chamadas.every((c) => c.op.endsWith('.createMany'))).toBe(true);
  });

  it('sem conta: lança antes de qualquer chamada', async () => {
    const g = gravador();
    await expect(ensureLabDefaults(g.prisma, '' as any)).rejects.toThrow();
    expect(g.chamadas).toEqual([]);
  });
});

describe('lab-defaults — seedLabTenantDefaults', () => {
  const grupos = () => GRUPOS_DE_PROTESE.map((g, i) => ({ id: `grupo-${i}`, name: g.name }));

  it('catálogo de prótese, categorias de laboratório, funil e chaves — sem anamnese e sem nada da clínica', async () => {
    const g = gravador({ 'specialty.findMany': grupos });
    const r = await seedLabTenantDefaults(g.prisma, LAB);

    expect(g.chamadas.map((c) => c.op)).toEqual([
      'specialty.createMany',
      'specialty.findMany',
      'procedure.createMany',
      'financialCategory.createMany',
      'pipeline.findFirst',
      'pipeline.create',
      'tenantSetting.createMany',
      'globalSetting.createMany',
    ]);
    expect(r.funil).toBe(true);
    // Nada de anamnese (nem a master) e nenhuma escrita que sobrescreva.
    expect(g.chamadas.some((c) => /anamnesis/i.test(c.op))).toBe(false);
    expect(g.chamadas.some((c) => /\.(update|updateMany|upsert|delete|deleteMany)$/.test(c.op))).toBe(false);
    // Tudo na conta do laboratório.
    for (const op of ['specialty.createMany', 'procedure.createMany', 'financialCategory.createMany']) {
      const [a] = g.de(op);
      expect(a.skipDuplicates).toBe(true);
      for (const linha of a.data) expect(linha.tenant_id).toBe(LAB);
    }
    expect(g.de('pipeline.create')[0].data.tenant_id).toBe(LAB);
  });

  it('serviços: preço 0, na venda rápida, sem comissão, cada um no seu grupo; nenhum nome da tabela da clínica', async () => {
    const g = gravador({ 'specialty.findMany': grupos });
    await seedLabTenantDefaults(g.prisma, LAB);
    const [{ data }] = g.de('procedure.createMany');

    expect(data).toHaveLength(SERVICOS_DE_PROTESE.length);
    const idDoGrupo = new Map<string, string>(grupos().map((x) => [x.name, x.id]));
    for (const linha of data) {
      expect(linha.base_price).toBe(0);
      expect(linha.quick_sale).toBe(true);
      expect(linha.commissionable).toBe(false);
      expect(linha).not.toHaveProperty('default_revisit_months');
      const servico = SERVICOS_DE_PROTESE.find((s) => s.name === linha.name)!;
      expect(linha.specialty_id).toBe(idDoGrupo.get(servico.grupo));
    }
    const daClinica = new Set(DEFAULT_PROCEDURES.map((p) => p.name));
    expect(data.filter((l: any) => daClinica.has(l.name))).toEqual([]);
    const gruposDaClinica = new Set<string>(DEFAULT_SPECIALTIES.map((s) => s.name));
    expect(GRUPOS_DE_PROTESE.filter((x) => gruposDaClinica.has(x.name))).toEqual([]);
    // Todo serviço aponta para um grupo que existe.
    const nomes = new Set<string>(GRUPOS_DE_PROTESE.map((x) => x.name));
    expect(SERVICOS_DE_PROTESE.filter((s) => !nomes.has(s.grupo))).toEqual([]);
  });

  it('categorias financeiras de laboratório: as da clínica ficam de fora; DIARIA fica (lançador de diária)', () => {
    const nomes = CATEGORIAS_FINANCEIRAS_DO_LABORATORIO.map((c) => c.name);
    for (const daClinica of ['Procedimento', 'Consulta', 'Material Odontologico', 'Laboratorio']) {
      expect(nomes).not.toContain(daClinica);
    }
    expect(CATEGORIAS_FINANCEIRAS_DO_LABORATORIO).toContainEqual(expect.objectContaining({ type: 'DESPESA', name: 'DIARIA' }));
    for (const c of CATEGORIAS_FINANCEIRAS_DO_LABORATORIO) expect(['RECEITA', 'DESPESA']).toContain(c.type);
  });

  it("funil 'Captação de dentistas': slugs sem 'agend'/'avalia'/'marcad', uma etapa inicial/ganho/perdido, nenhuma cai em 'agendado'", async () => {
    const g = gravador({ 'specialty.findMany': grupos });
    await seedLabTenantDefaults(g.prisma, LAB);
    const [{ data }] = g.de('pipeline.create');
    const etapas = data.stages.create;

    expect(data.slug).toBe('captacao-dentistas');
    expect(data.is_default).toBe(true);
    for (const t of [data.slug, ...etapas.map((s: any) => s.slug), ...etapas.map((s: any) => normalizar(s.name))]) {
      expect(t).not.toMatch(/agend|avalia|marcad/);
    }
    expect(etapas.filter((s: any) => s.is_initial)).toHaveLength(1);
    expect(etapas.filter((s: any) => s.is_won)).toHaveLength(1);
    expect(etapas.filter((s: any) => s.is_lost)).toHaveLength(1);
    expect(new Set(etapas.map((s: any) => s.slug)).size).toBe(etapas.length);
    expect(etapas.map((s: any) => s.position)).toEqual(etapas.map((_: any, i: number) => i));
    for (const s of etapas) expect(generalStageOf(s, etapas)).not.toBe('agendado');
  });

  it('nada de texto de clínica no que o laboratório recebe', () => {
    // O detector pega o vocabulário da clínica (com acento e plural) e deixa passar o do laboratório.
    for (const t of ['Ficha do Paciente', 'Consultas do dia', 'Prontuário', 'Material Odontológico']) {
      expect(textoDeClinica(t)).not.toBeNull();
    }
    expect(textoDeClinica('Visita ao consultório')).toBeNull();
    const achados = textosDoLaboratorio()
      .map((t) => [t, textoDeClinica(t)] as const)
      .filter(([, termo]) => termo);
    expect(achados).toEqual([]);
  });

  it('2ª execução: funil existente não é recriado; o resto é createMany com skipDuplicates', async () => {
    const g = gravador({ 'specialty.findMany': grupos, 'pipeline.findFirst': () => ({ id: 'funil-1' }) });
    const r = await seedLabTenantDefaults(g.prisma, LAB);
    expect(r.funil).toBe(false);
    expect(g.de('pipeline.create')).toEqual([]);
    expect(g.de('pipeline.findFirst')).toEqual([{ where: { tenant_id: LAB, slug: 'captacao-dentistas' }, select: { id: true } }]);
  });
});

describe('lab-tenants — invalidarCacheLabTenants', () => {
  beforeEach(() => __limparCacheLabTenants());
  afterAll(() => __limparCacheLabTenants());

  const banco = (respostas: Array<() => Promise<Array<{ tenant_id: string }>>>) => {
    const findMany = jest.fn();
    for (const r of respostas) findMany.mockImplementationOnce(r);
    return { prisma: { tenantBusinessProfile: { findMany } }, findMany };
  };

  it('depois de invalidar, a próxima leitura vai ao banco e já vê a conta nova', async () => {
    const { prisma, findMany } = banco([async () => [], async () => [{ tenant_id: LAB }]]);
    expect((await getLabTenantIds(prisma)).size).toBe(0);
    expect((await getLabTenantIds(prisma)).size).toBe(0); // cache
    expect(findMany).toHaveBeenCalledTimes(1);

    invalidarCacheLabTenants();
    expect(isLabTenantCached(LAB)).toBe(false);
    expect((await getLabTenantIds(prisma)).has(LAB)).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(isLabTenantCached(LAB)).toBe(true);
  });

  it('invalidar e a releitura falhar: os laboratórios já conhecidos continuam laboratório', async () => {
    const { prisma, findMany } = banco([
      async () => [{ tenant_id: LAB }],
      async () => {
        throw new Error('banco fora');
      },
    ]);
    expect((await getLabTenantIds(prisma, () => undefined)).has(LAB)).toBe(true);
    invalidarCacheLabTenants();
    expect((await getLabTenantIds(prisma, () => undefined)).has(LAB)).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(isLabTenantCached(LAB)).toBe(true);
  });

  it('consulta antiga que termina depois da invalidação não regrava a lista velha', async () => {
    let soltarVelha!: (v: Array<{ tenant_id: string }>) => void;
    const velha = new Promise<Array<{ tenant_id: string }>>((res) => (soltarVelha = res));
    const { prisma } = banco([() => velha, async () => [{ tenant_id: LAB }]]);

    const pendente = getLabTenantIds(prisma);
    invalidarCacheLabTenants();
    expect((await getLabTenantIds(prisma)).has(LAB)).toBe(true);

    soltarVelha([]);
    expect((await pendente).size).toBe(0); // quem pediu antes recebe o que pediu
    expect(isLabTenantCached(LAB)).toBe(true); // mas o cache fica com a lista nova
  });
});
