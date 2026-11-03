/**
 * F8 do laboratório — bloco DADOS DO CASO no PDF do orçamento de trabalho, sem o
 * paciente do caso.
 *
 * O PDF do laboratório (que também vai anexado no WhatsApp) mostra só cor, material e
 * entrega prometida. O banco simulado DEVOLVE a ficha inteira, ignorando o select
 * (paciente do caso, dentista solicitante, instruções e link com SENTINELA): mesmo
 * assim nenhum text() nem o título do documento pode ter a SENTINELA, e o select que
 * chega ao banco é exatamente {shade, material, due_date}.
 *
 * Clínica: a ficha do caso nunca é lida e o PDF de sempre não muda (o retrato fica em
 * __guards__/pdf-text.spec.ts).
 *
 * pdfkit real com um gravador dos text() (como quote-pdf.lab.spec.ts); dados de exemplo.
 */
import { Logger } from '@nestjs/common';
import { Prisma, __limparCacheLabTenants } from '@crm/shared';
import PDFKit from 'pdfkit';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';
import { LAB_ORCAMENTO_PDF } from './lab-orcamento-textos';
import { QuotePdfService } from './quote-pdf.service';
import { desenharOrcamentoDoLaboratorio, linhasDoCasoNoPdf } from './quote-pdf-laboratorio';

jest.mock('pdfkit', () => {
  const PDFKitReal = jest.requireActual('pdfkit');
  class PdfGravador extends PDFKitReal {
    static documentos: any[] = [];
    constructor(opcoes?: any) {
      super(opcoes);
      (this as any).__opcoes = opcoes;
      (this as any).__textos = [];
      PdfGravador.documentos.push(this);
    }
    text(texto: any, x?: any, y?: any, opcoes?: any) {
      (this as any).__textos.push(String(texto));
      return super.text(texto, x, y, opcoes);
    }
  }
  return { __esModule: true, default: PdfGravador };
});

const LAB = '00000000-0000-0000-0000-0000000000a1';
const CLINICA = '00000000-0000-0000-0000-0000000000c1';
const ORC = 'a1b2c3d4-0000-4000-8000-000000000001';
const ORIGEM = 'a1b2c3d4-0000-4000-8000-000000000000';
const SENTINELA = 'SENTINELA-CASO-7Q';
const D = (v: string) => new Prisma.Decimal(v);

const documentos = (): any[] => (PDFKit as any).documentos;
const textos = (doc: any): string[] => doc.__textos;

let avisos: string[] = [];
beforeEach(() => {
  __limparCacheLabTenants();
  documentos().length = 0;
  avisos = [];
  jest.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => void avisos.push(`log: ${m}`));
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => void avisos.push(`warn: ${m}`));
  jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => void avisos.push(`error: ${m}`));
});
afterEach(() => jest.restoreAllMocks());

function orcamento(conta: string, over: Record<string, any> = {}) {
  return {
    id: ORC,
    quote_number: 42,
    status: 'SENT',
    created_at: new Date('2026-10-18T14:00:00.000Z'),
    valid_until: new Date('2026-11-17T15:00:00.000Z'),
    subtotal: D('450.00'),
    discount_percent: D('0.00'),
    discount_value: D('0.00'),
    total_value: D('450.00'),
    payment_terms: null,
    chosen_payment_key: null,
    chosen_down_payment: null,
    avista_discount_enabled: false,
    avista_discount_pct: D('0.00'),
    notes: null,
    patient: {
      id: 'cli-exemplo-1',
      name: 'Clínica Parceira Exemplo',
      cpf: '11222333000181',
      phone: '5582900000001',
      email: 'contato@parceira.test',
      tenant_id: conta,
      address: null,
      address_number: null,
      neighborhood: null,
      city: null,
      state: null,
      zip_code: null,
    },
    created_by: { name: 'Atendimento Exemplo' },
    items: [
      { id: 'qi-1', tooth_fdi: '11', quantity: 1, unit_price: D('450.00'), total_price: D('450.00'), notes: null, procedure: { name: 'Coroa de zircônia', code_tuss: null } },
    ],
    attachments: [],
    ...over,
  };
}

/** A ficha do caso como está na tabela: com tudo, inclusive o que nunca pode ir ao PDF. */
function fichaInteira(quote_id: string, over: Record<string, any> = {}) {
  return {
    quote_id,
    tenant_id: LAB,
    patient_ref: `${SENTINELA}-paciente`,
    requested_by_name: `${SENTINELA}-solicitante`,
    shade: 'A2',
    material: 'Zircônia',
    due_date: new Date('2026-11-12T00:00:00.000Z'),
    instructions: `${SENTINELA}-instrucoes`,
    external_files_url: `https://exemplo.test/${SENTINELA}`,
    received_at: new Date('2026-10-30T00:00:00.000Z'),
    created_at: new Date('2026-10-30T12:00:00.000Z'),
    updated_at: new Date('2026-10-30T12:00:00.000Z'),
    ...over,
  };
}

/**
 * Banco simulado: o findFirst da ficha do caso IGNORA o select e devolve a linha
 * inteira; o orçamento de origem é lido para a herança.
 */
function montar(conta: string, labs: string[], quote: any, fichas: any[], origens: Record<string, string | null> = {}) {
  const prisma: any = {
    quote: {
      findUnique: jest.fn().mockResolvedValue(quote),
      findFirst: jest.fn(async (args: any) => {
        const id = args?.where?.id;
        return id in origens ? { accepted_from_id: origens[id], renegotiated_from_id: null } : null;
      }),
    },
    quoteLabCase: {
      findFirst: jest.fn(async (args: any) => {
        return fichas.find((f) => f.quote_id === args?.where?.quote_id && f.tenant_id === args?.where?.tenant_id) ?? null;
      }),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Laboratório Exemplo', logo_url: null, phone: null, email: null, cpf_cnpj: null, city: null, state: null }),
    },
    tenantBusinessProfile: { findMany: jest.fn().mockResolvedValue(labs.map((tenant_id) => ({ tenant_id }))) },
  };
  return { svc: new QuotePdfService(prisma), prisma };
}

function semSentinela(doc: any) {
  const t = textos(doc);
  expect(t.filter((x) => x.includes(SENTINELA))).toEqual([]);
  expect(JSON.stringify(doc.__opcoes.info)).not.toContain(SENTINELA);
  expect(avisos.filter((a) => a.includes(SENTINELA))).toEqual([]);
}

describe('PDF do laboratório — bloco DADOS DO CASO sem o paciente do caso (F8)', () => {
  it.each([
    ['com valores', true],
    ['sem valores', false],
  ])('%s: cor, material e entrega prometida, entre CLIENTE e SERVIÇOS, e nada da SENTINELA', async (_n, comValores) => {
    const m = montar(LAB, [LAB], orcamento(LAB), [fichaInteira(ORC)]);
    await m.svc.generatePdf(ORC, LAB, comValores);
    const [doc] = documentos();
    const t = textos(doc);

    expect(t).toEqual(expect.arrayContaining(['DADOS DO CASO', 'Cor: A2', 'Material: Zircônia', 'Entrega prometida: 12/11/2026']));
    const i = (x: string) => t.indexOf(x);
    expect(i('CLIENTE')).toBeLessThan(i('DADOS DO CASO'));
    expect(i('DADOS DO CASO')).toBeLessThan(i('Cor: A2'));
    expect(i('Cor: A2')).toBeLessThan(i('Material: Zircônia'));
    expect(i('Material: Zircônia')).toBeLessThan(i('Entrega prometida: 12/11/2026'));
    expect(i('Entrega prometida: 12/11/2026')).toBeLessThan(i('SERVIÇOS'));

    semSentinela(doc);
    expect(t.filter((x) => temPalavraDeClinica(x))).toEqual([]);
    expect(doc.__opcoes.info.Title).toBe('Orçamento de trabalho nº 42 — Clínica Parceira Exemplo');

    // O select que chega ao banco é fechado nos 3 campos, com a conta do pedido.
    const chamadas = m.prisma.quoteLabCase.findFirst.mock.calls.map((c: any[]) => c[0]);
    expect(chamadas).toEqual([{ where: { quote_id: ORC, tenant_id: LAB }, select: { shade: true, material: true, due_date: true } }]);
    expect(avisos.filter((a) => a.startsWith('warn') || a.startsWith('error'))).toEqual([]);
  });

  it('caso herdado do orçamento de origem: o mesmo bloco, o mesmo select e nada da SENTINELA', async () => {
    const m = montar(LAB, [LAB], orcamento(LAB), [fichaInteira(ORIGEM)], { [ORC]: ORIGEM });
    await m.svc.generatePdf(ORC, LAB);
    const [doc] = documentos();
    expect(textos(doc)).toEqual(expect.arrayContaining(['Cor: A2', 'Material: Zircônia', 'Entrega prometida: 12/11/2026']));
    semSentinela(doc);
    for (const c of m.prisma.quoteLabCase.findFirst.mock.calls) {
      expect(c[0].select).toEqual({ shade: true, material: true, due_date: true });
      expect(c[0].where.tenant_id).toBe(LAB);
    }
  });

  it('só as linhas preenchidas; sem nenhuma, o bloco não sai', async () => {
    const m1 = montar(LAB, [LAB], orcamento(LAB), [fichaInteira(ORC, { shade: '  ', material: null })]);
    await m1.svc.generatePdf(ORC, LAB);
    const t1 = textos(documentos()[0]);
    expect(t1).toEqual(expect.arrayContaining(['DADOS DO CASO', 'Entrega prometida: 12/11/2026']));
    expect(t1.filter((x) => /^(Cor|Material):/.test(x))).toEqual([]);
    semSentinela(documentos()[0]);

    documentos().length = 0;
    __limparCacheLabTenants();
    const m2 = montar(LAB, [LAB], orcamento(LAB), [fichaInteira(ORC, { shade: null, material: '', due_date: null })]);
    await m2.svc.generatePdf(ORC, LAB);
    const t2 = textos(documentos()[0]);
    expect(t2.filter((x) => x === 'DADOS DO CASO' || /^(Cor|Material|Entrega prometida):/.test(x))).toEqual([]);
    semSentinela(documentos()[0]);

    documentos().length = 0;
    __limparCacheLabTenants();
    const m3 = montar(LAB, [LAB], orcamento(LAB), []);
    await m3.svc.generatePdf(ORC, LAB);
    expect(textos(documentos()[0])).not.toContain('DADOS DO CASO');
  });

  it('leitura da ficha que falha: PDF sai sem o bloco, com aviso sem nenhum valor', async () => {
    const m = montar(LAB, [LAB], orcamento(LAB), []);
    m.prisma.quoteLabCase.findFirst.mockRejectedValue(new Error('tabela indisponível'));
    const buf = await m.svc.generatePdf(ORC, LAB);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(textos(documentos()[0])).not.toContain('DADOS DO CASO');
    expect(avisos.filter((a) => a.startsWith('warn: [LAB-CASO] pdf'))).toHaveLength(1);
  });

  it('clínica (com e sem outra conta de laboratório): a ficha do caso nunca é lida', async () => {
    for (const labs of [[], [LAB]]) {
      documentos().length = 0;
      __limparCacheLabTenants();
      const m = montar(CLINICA, labs, orcamento(CLINICA), [fichaInteira(ORC, { tenant_id: CLINICA })]);
      m.prisma.tenant.findUnique.mockResolvedValue({ name: 'Clínica Exemplo' });
      await m.svc.generatePdf(ORC, CLINICA);
      expect(m.prisma.quoteLabCase.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.quote.findFirst).not.toHaveBeenCalled();
      const t = textos(documentos()[0]);
      expect(t).toEqual(expect.arrayContaining(['CLÍNICA EXEMPLO', 'PACIENTE']));
      expect(t.filter((x) => x === 'DADOS DO CASO' || /^(Cor|Material|Entrega prometida):/.test(x))).toEqual([]);
      semSentinela(documentos()[0]);
    }
  });

  it('desenharOrcamentoDoLaboratorio sem o 4º parâmetro: o PDF da F6, sem o bloco', async () => {
    await desenharOrcamentoDoLaboratorio(orcamento(LAB), null, true);
    expect(textos(documentos()[0])).not.toContain('DADOS DO CASO');
  });

  it('linhasDoCasoNoPdf lê só cor, material e entrega (dia gravado, sem fuso)', () => {
    expect(linhasDoCasoNoPdf(null)).toEqual([]);
    expect(linhasDoCasoNoPdf(fichaInteira(ORC) as any)).toEqual(['Cor: A2', 'Material: Zircônia', 'Entrega prometida: 12/11/2026']);
    // Meia-noite UTC é o dia gravado: nunca o dia anterior.
    expect(linhasDoCasoNoPdf({ shade: null, material: null, due_date: new Date('2026-01-01T00:00:00.000Z') })).toEqual([
      'Entrega prometida: 01/01/2026',
    ]);
    expect(linhasDoCasoNoPdf({ shade: ' B1 ', material: null, due_date: null })).toEqual(['Cor: B1']);
  });

  it('textos novos do PDF: sem vocabulário de clínica', () => {
    const T = LAB_ORCAMENTO_PDF.caso;
    const novos = [T.titulo, T.cor('A2'), T.material('Zircônia'), T.entregaPrometida('12/11/2026')];
    expect(novos.filter((x) => temPalavraDeClinica(x))).toEqual([]);
    expect(Object.isFrozen(T)).toBe(true);
  });
});
