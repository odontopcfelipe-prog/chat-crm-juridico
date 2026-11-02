/**
 * F8 do laboratório — o caso HERDADO por leitura.
 *
 * Aprovação parcial (accepted_from_id) e renegociação (renegotiated_from_id) criam
 * um orçamento novo sem copiar a ficha do caso. Sem caso próprio, o GET sobe pela
 * origem (até NIVEIS_DE_HERANCA níveis) e devolve o caso de lá com herdado_de; o PUT grava sempre
 * no orçamento pedido e nunca toca o de origem. A lista do cliente resolve a mesma
 * herança em 2 leituras. O PDF lê só cor, material e entrega (select fechado) e
 * nunca lança.
 */
import { NIVEIS_DE_HERANCA, lerCasoParaPdf } from './caso-do-orcamento';
import { LabFichasService } from './lab-fichas.service';

const A = 'lab-a';
const B = 'lab-b';
type Reg = Record<string, any>;

const orc = (id: string, extra: Reg = {}): Reg => ({
  id,
  patient_id: 'cli-a',
  deleted_at: null,
  accepted_from_id: null,
  renegotiated_from_id: null,
  created_at: new Date('2026-10-01T12:00:00.000Z'),
  ...extra,
});

function montar() {
  const quando = new Date('2026-10-20T12:00:00.000Z');
  const db: Record<string, Reg[]> = {
    patient: [
      { id: 'cli-a', tenant_id: A, cpf: null },
      { id: 'cli-b', tenant_id: B, cpf: null },
    ],
    quote: [
      // Original enviado (depois apagado) → aprovação parcial → renegociação.
      orc('orc-original', { deleted_at: new Date('2026-10-10T00:00:00.000Z'), created_at: new Date('2026-09-01T12:00:00.000Z') }),
      orc('orc-parcial', { accepted_from_id: 'orc-original', created_at: new Date('2026-09-10T12:00:00.000Z') }),
      orc('orc-renegociado', { renegotiated_from_id: 'orc-parcial', created_at: new Date('2026-09-20T12:00:00.000Z') }),
      // Revisões em série (Revisar → nova versão): até o teto a herança chega; acima, não.
      ...Array.from({ length: NIVEIS_DE_HERANCA + 1 }, (_, i) =>
        orc(`orc-n${i + 1}`, {
          renegotiated_from_id: i === 0 ? 'orc-original' : `orc-n${i}`,
          created_at: new Date(Date.UTC(2026, 7, 2 + i, 12)),
        }),
      ),
      orc('orc-proprio', { accepted_from_id: 'orc-original', created_at: new Date('2026-10-06T12:00:00.000Z') }),
      orc('orc-sem-caso', { created_at: new Date('2026-10-07T12:00:00.000Z') }),
      // Origem em outra conta (não acontece; defesa): não herda.
      orc('orc-de-b', { patient_id: 'cli-b' }),
      orc('orc-aponta-b', { accepted_from_id: 'orc-de-b', created_at: new Date('2026-10-08T12:00:00.000Z') }),
    ],
    quoteLabCase: [
      {
        quote_id: 'orc-original',
        tenant_id: A,
        patient_ref: 'Iniciais do caso',
        requested_by_name: 'Dra. Ana',
        shade: 'A2',
        material: 'Zircônia',
        due_date: new Date('2026-11-20T00:00:00.000Z'),
        instructions: 'Contato forte',
        external_files_url: 'https://arquivos.example.com/caso/1',
        received_at: new Date('2026-10-01T00:00:00.000Z'),
        updated_at: quando,
      },
      { quote_id: 'orc-proprio', tenant_id: A, shade: 'B1', material: null, due_date: null, updated_at: quando },
      { quote_id: 'orc-de-b', tenant_id: B, shade: 'C3', updated_at: quando },
    ],
  };
  const casa = (tabela: string, r: Reg, where: Reg = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v === undefined) return true;
      if (k === 'patient' && tabela === 'quote') return db.patient.find((p) => p.id === r.patient_id)?.tenant_id === v.tenant_id;
      if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(r[k]);
      return r[k] === v;
    });
  const recorte = (r: Reg | null, select?: Reg) =>
    r && select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])) : r;
  const prisma: any = {};
  for (const tabela of Object.keys(db)) {
    prisma[tabela] = {
      findFirst: jest.fn(async (a: Reg = {}) => recorte(db[tabela].find((r) => casa(tabela, r, a.where)) ?? null, a.select)),
      findUnique: jest.fn(async (a: Reg = {}) => recorte(db[tabela].find((r) => casa(tabela, r, a.where)) ?? null, a.select)),
      findMany: jest.fn(async (a: Reg = {}) => {
        const lista = db[tabela].filter((r) => casa(tabela, r, a.where));
        if (a.orderBy?.created_at === 'desc') lista.sort((x, y) => y.created_at.getTime() - x.created_at.getTime());
        return lista.map((r) => recorte(r, a.select));
      }),
      upsert: jest.fn(async (a: Reg) => {
        const atual = db[tabela].find((r) => casa(tabela, r, a.where));
        if (atual) return Object.assign(atual, a.update, { updated_at: quando });
        const novo = { ...a.create, updated_at: quando };
        db[tabela].push(novo);
        return novo;
      }),
      update: jest.fn(async (a: Reg) => Object.assign(db[tabela].find((r) => casa(tabela, r, a.where))!, a.data)),
    };
  }
  return { db, prisma, service: new LabFichasService(prisma) };
}

const ADM = { id: 'adm-a', roles: ['ADMIN'] };
const DO_ORIGINAL = {
  patient_ref: 'Iniciais do caso',
  requested_by_name: 'Dra. Ana',
  shade: 'A2',
  material: 'Zircônia',
  due_date: '2026-11-20',
  instructions: 'Contato forte',
  external_files_url: 'https://arquivos.example.com/caso/1',
  received_at: '2026-10-01',
};

describe('caso herdado — GET', () => {
  it('aprovação parcial sem caso → o caso do original, com herdado_de', async () => {
    const m = montar();
    await expect(m.service.lerCaso(ADM, A, 'orc-parcial')).resolves.toEqual({
      quote_id: 'orc-parcial',
      gravado: false,
      herdado_de: 'orc-original',
      updated_at: '2026-10-20T12:00:00.000Z',
      ...DO_ORIGINAL,
    });
  });

  it('renegociação da aprovação parcial (2 níveis) → ainda o caso do original', async () => {
    const m = montar();
    await expect(m.service.lerCaso(ADM, A, 'orc-renegociado')).resolves.toMatchObject({
      quote_id: 'orc-renegociado',
      gravado: false,
      herdado_de: 'orc-original',
      shade: 'A2',
    });
  });

  it(`várias revisões seguidas herdam até ${NIVEIS_DE_HERANCA} níveis; acima do teto não herda`, async () => {
    const m = montar();
    expect(NIVEIS_DE_HERANCA).toBeGreaterThanOrEqual(10);
    await expect(m.service.lerCaso(ADM, A, 'orc-n5')).resolves.toMatchObject({ herdado_de: 'orc-original', shade: 'A2' });
    await expect(m.service.lerCaso(ADM, A, `orc-n${NIVEIS_DE_HERANCA}`)).resolves.toMatchObject({ herdado_de: 'orc-original', shade: 'A2' });
    await expect(m.service.lerCaso(ADM, A, `orc-n${NIVEIS_DE_HERANCA + 1}`)).resolves.toMatchObject({ gravado: false, herdado_de: null, shade: null });
  });

  it('caso próprio vence a origem; origem em outra conta não herda', async () => {
    const m = montar();
    await expect(m.service.lerCaso(ADM, A, 'orc-proprio')).resolves.toMatchObject({ gravado: true, herdado_de: null, shade: 'B1', material: null });
    await expect(m.service.lerCaso(ADM, A, 'orc-aponta-b')).resolves.toMatchObject({ gravado: false, herdado_de: null, shade: null });
  });
});

describe('caso herdado — PUT', () => {
  it('grava no orçamento novo (partindo do herdado) e não toca o de origem', async () => {
    const m = montar();
    const antes = { ...m.db.quoteLabCase.find((c) => c.quote_id === 'orc-original') };
    const r = await m.service.gravarCaso(ADM, A, 'orc-parcial', { shade: 'A3' });
    expect(m.prisma.quoteLabCase.upsert).toHaveBeenCalledTimes(1);
    const args = m.prisma.quoteLabCase.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ quote_id: 'orc-parcial' });
    expect(args.create).toMatchObject({ quote_id: 'orc-parcial', tenant_id: A, shade: 'A3', material: 'Zircônia', patient_ref: 'Iniciais do caso' });
    expect(r).toMatchObject({ quote_id: 'orc-parcial', gravado: true, herdado_de: null, ...DO_ORIGINAL, shade: 'A3' });
    expect(m.db.quoteLabCase.find((c) => c.quote_id === 'orc-original')).toEqual(antes);
    expect(m.prisma.quoteLabCase.update).not.toHaveBeenCalled();
    // Depois de gravar, o GET do novo é o próprio.
    await expect(m.service.lerCaso(ADM, A, 'orc-parcial')).resolves.toMatchObject({ gravado: true, herdado_de: null, shade: 'A3' });
  });
});

describe('caso herdado — lista do cliente', () => {
  it('resolve a herança de cada orçamento não apagado, em 2 leituras', async () => {
    const m = montar();
    const { casos } = await m.service.listarCasosDoCliente(A, 'cli-a');
    const resumo = Object.fromEntries(casos.map((c) => [c.quote_id, [c.gravado, c.herdado_de, c.shade]]));
    expect(resumo).toEqual({
      'orc-parcial': [false, 'orc-original', 'A2'],
      'orc-renegociado': [false, 'orc-original', 'A2'],
      ...Object.fromEntries(
        Array.from({ length: NIVEIS_DE_HERANCA + 1 }, (_, i) => [
          `orc-n${i + 1}`,
          i < NIVEIS_DE_HERANCA ? [false, 'orc-original', 'A2'] : [false, null, null],
        ]),
      ),
      'orc-proprio': [true, null, 'B1'],
      'orc-sem-caso': [false, null, null],
      'orc-aponta-b': [false, null, null],
    });
    // O apagado não aparece (só serve de elo); o mais novo vem primeiro.
    expect(casos.map((c) => c.quote_id)).not.toContain('orc-original');
    expect(casos[0].quote_id).toBe('orc-aponta-b');
    expect(m.prisma.quote.findMany).toHaveBeenCalledTimes(1);
    expect(m.prisma.quoteLabCase.findMany).toHaveBeenCalledTimes(1);
    expect(m.prisma.quoteLabCase.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.quoteLabCase.findMany.mock.calls[0][0].where.tenant_id).toBe(A);
  });
});

describe('lerCasoParaPdf', () => {
  it('select exatamente {shade, material, due_date}, com a herança', async () => {
    const m = montar();
    await expect(lerCasoParaPdf(m.prisma, 'orc-renegociado', A)).resolves.toEqual({
      shade: 'A2',
      material: 'Zircônia',
      due_date: new Date('2026-11-20T00:00:00.000Z'),
    });
    const selects = m.prisma.quoteLabCase.findFirst.mock.calls.map((c: Reg[]) => c[0].select);
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).toEqual({ shade: true, material: true, due_date: true });
    for (const c of m.prisma.quoteLabCase.findFirst.mock.calls) expect(c[0].where.tenant_id).toBe(A);
  });

  it('sem caso → null; outra conta → null', async () => {
    const m = montar();
    await expect(lerCasoParaPdf(m.prisma, 'orc-sem-caso', A)).resolves.toBeNull();
    await expect(lerCasoParaPdf(m.prisma, 'orc-de-b', A)).resolves.toBeNull();
    await expect(lerCasoParaPdf(m.prisma, 'orc-proprio', null)).resolves.toBeNull();
  });

  it('banco sem a tabela do caso (ou que falha) → null e aviso, nunca lança', async () => {
    const avisos: string[] = [];
    const semTabela = { quote: { findFirst: jest.fn() } };
    await expect(lerCasoParaPdf(semTabela, 'orc-x', A, (m) => avisos.push(m))).resolves.toBeNull();
    const falha = { quote: { findFirst: jest.fn() }, quoteLabCase: { findFirst: jest.fn().mockRejectedValue(new Error('fora do ar')) } };
    await expect(lerCasoParaPdf(falha, 'orc-y', A, (m) => avisos.push(m))).resolves.toBeNull();
    await expect(lerCasoParaPdf(falha, 'orc-z', A)).resolves.toBeNull();
    expect(avisos).toHaveLength(2);
    for (const a of avisos) expect(a).toMatch(/^\[LAB-CASO\] pdf orc-[xy]/);
  });
});
