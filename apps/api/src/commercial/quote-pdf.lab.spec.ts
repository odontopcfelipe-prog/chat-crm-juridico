/**
 * F6 do laboratório — PDF do orçamento de trabalho (QuotePdfService.generatePdf numa conta
 * de laboratório → desenharOrcamentoDoLaboratorio).
 *
 *   - o que é desenhado: nome e logo da PRÓPRIA conta, CLIENTE, SERVIÇOS (Serviço |
 *     Elemento), Nº do orçamento; nenhum texto com vocabulário de clínica (o mesmo detector
 *     do LabVocabInterceptor) e nada da clínica (nome fixo, PACIENTE, TUSS, RG, Banco
 *     PASSOS, PagBank, consulta de crédito);
 *   - logo só em data URI PNG/JPG; link http não é baixado e o PDF sai sem logo;
 *   - a caixa da proposta de pagamento faz a MESMA conta da clínica;
 *   - clínica: o desenho de sempre, sem ler a conta (o retrato fica em
 *     __guards__/pdf-text.spec.ts, que não muda).
 *
 * Sem retrato (snapshot) de propósito: o texto é conferido pelas regras acima. pdfkit real,
 * com um gravador dos text() (como o pdf-text.spec); dados de exemplo.
 */
import { Logger } from '@nestjs/common';
import { Prisma, __limparCacheLabTenants } from '@crm/shared';
import PDFKit from 'pdfkit';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';
import { QuotePdfService } from './quote-pdf.service';
import { desenharOrcamentoDoLaboratorio, ofertaDePagamentoDoLaboratorio } from './quote-pdf-laboratorio';

jest.mock('pdfkit', () => {
  const PDFKitReal = jest.requireActual('pdfkit');
  class PdfGravador extends PDFKitReal {
    static documentos: any[] = [];
    constructor(opcoes?: any) {
      super(opcoes);
      (this as any).__opcoes = opcoes;
      (this as any).__textos = [];
      (this as any).__imagens = 0;
      PdfGravador.documentos.push(this);
    }
    text(texto: any, x?: any, y?: any, opcoes?: any) {
      (this as any).__textos.push(String(texto));
      return super.text(texto, x, y, opcoes);
    }
    addPage(opcoes?: any) {
      (this as any).__paginas = ((this as any).__paginas ?? 0) + 1;
      return super.addPage(opcoes);
    }
    image(...args: any[]) {
      (this as any).__imagens += 1;
      return (super.image as any)(...args);
    }
  }
  return { __esModule: true, default: PdfGravador };
});

const LAB = '00000000-0000-0000-0000-0000000000a1';
const CLINICA = '00000000-0000-0000-0000-0000000000c1';
const D = (v: string) => new Prisma.Decimal(v);
const LOGO_PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

function cliente(conta: string, over: Record<string, any> = {}) {
  return {
    id: 'cli-exemplo-1',
    name: 'Clínica Parceira Exemplo',
    cpf: '11222333000181',
    rg: '0000000 SSP/AL',
    birth_date: new Date('1990-05-12T12:00:00.000Z'),
    phone: '5582900000001',
    email: 'contato@parceira.test',
    tenant_id: conta,
    address: 'Rua Exemplo',
    address_number: '100',
    neighborhood: 'Centro',
    city: 'Cidade Exemplo',
    state: 'AL',
    zip_code: '57000-000',
    ...over,
  };
}

function orcamento(conta: string, over: Record<string, any> = {}) {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    quote_number: 42,
    status: 'SENT',
    created_at: new Date('2026-10-18T14:00:00.000Z'),
    valid_until: new Date('2026-11-17T15:00:00.000Z'),
    subtotal: D('900.00'),
    discount_percent: D('10.00'),
    discount_value: D('90.00'),
    total_value: D('810.00'),
    payment_terms: 'Entrada + 6x no boleto',
    chosen_payment_key: 'parcelado-6x',
    chosen_down_payment: D('110.00'),
    avista_discount_enabled: false,
    avista_discount_pct: D('0.00'),
    notes: 'Cor A2, prova em 5 dias.',
    patient: cliente(conta),
    created_by: { name: 'Atendimento Exemplo' },
    items: [
      { id: 'qi-1', tooth_fdi: '11', quantity: 1, unit_price: D('450.00'), total_price: D('450.00'), notes: 'Zircônia', procedure: { name: 'Coroa de zircônia', code_tuss: '00000001' } },
      { id: 'qi-2', tooth_fdi: null, quantity: 1, unit_price: D('450.00'), total_price: D('450.00'), notes: null, procedure: { name: 'Placa miorrelaxante', code_tuss: null } },
    ],
    attachments: [{ id: 'att-1', filename: 'escaneamento.stl', category: 'ARQUIVO', mime_type: 'model/stl' }],
    ...over,
  };
}

const CONTA = {
  name: 'Laboratório Exemplo',
  logo_url: LOGO_PNG_1X1,
  phone: '5582900000002',
  email: 'contato@lab-exemplo.test',
  cpf_cnpj: '11222333000181',
  city: 'Cidade Exemplo',
  state: 'AL',
};

function montar(conta: string, labs: string[], quote: any, tenant: any = CONTA) {
  const prisma: any = {
    // F8: sem ficha do caso (o bloco do caso fica em lab-caso-pdf.privacidade.spec.ts).
    quote: { findUnique: jest.fn().mockResolvedValue(quote), findFirst: jest.fn().mockResolvedValue(null) },
    quoteLabCase: { findFirst: jest.fn().mockResolvedValue(null) },
    tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
    tenantBusinessProfile: { findMany: jest.fn().mockResolvedValue(labs.map((tenant_id) => ({ tenant_id }))) },
  };
  return { svc: new QuotePdfService(prisma), prisma, conta };
}

/** Textos de clínica que não podem aparecer no PDF do laboratório. */
const DA_CLINICA = [
  'INSTITUTO ODONTO PASSOS',
  'Clinica Odontologica',
  'PACIENTE',
  'PROCEDIMENTOS',
  'Procedimento',
  'Dente',
  'TUSS',
  'RG:',
  'portal do paciente',
  'Banco PASSOS',
  'consulta de crédito',
  'PagBank',
];

describe('PDF do orçamento de trabalho (F6)', () => {
  it('com valores: conta, cliente, serviços, número e nenhum texto de clínica', async () => {
    const m = montar(LAB, [LAB], orcamento(LAB));
    const buf = await m.svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', LAB);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(documentos()).toHaveLength(1);
    const [doc] = documentos();
    const t = textos(doc);
    const tudo = t.join('\n');

    for (const proibido of DA_CLINICA) expect(tudo.includes(proibido) ? proibido : 'ok').toBe('ok');
    expect(t.filter((x) => temPalavraDeClinica(x))).toEqual([]);

    expect(t).toEqual(expect.arrayContaining(['Laboratório Exemplo', 'CLIENTE', 'SERVIÇOS', 'Serviço', 'Elemento', 'Nº 42', 'ORÇAMENTO DE TRABALHO']));
    expect(t).toEqual(expect.arrayContaining(['CPF/CNPJ: 11.222.333/0001-81', 'CNPJ: 11.222.333/0001-81']));
    expect(t).toEqual(expect.arrayContaining(['Coroa de zircônia', 'Placa miorrelaxante', '11', '-']));
    expect(t).toEqual(expect.arrayContaining(['Os arquivos podem ser solicitados ao laboratório.', 'Assinatura do cliente']));
    expect(tudo).toContain('Orçamento nº 42 · Emitido em');
    expect(tudo).toContain('R$');
    expect(tudo).toContain('no boleto (1,5% a.m.)');
    expect(doc.__opcoes.info.Title).toBe('Orçamento de trabalho nº 42 — Clínica Parceira Exemplo');

    // Conta lida pelo id do usuário; logo PNG embutida uma vez.
    expect(m.prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: LAB },
      select: { name: true, logo_url: true, phone: true, email: true, cpf_cnpj: true, city: true, state: true },
    });
    expect(doc.__imagens).toBe(1);
    expect(avisos.filter((a) => a.startsWith('warn') || a.startsWith('error'))).toEqual([]);
  });

  it('sem valores: só os serviços, sem R$, totais nem proposta de pagamento', async () => {
    const m = montar(LAB, [LAB], orcamento(LAB));
    await m.svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', LAB, false);
    const tudo = textos(documentos()[0]).join('\n');
    expect(tudo).not.toMatch(/R\$|TOTAL|PAGAMENTO|Unitário/);
    expect(tudo).toContain('Ao assinar, declaro estar ciente dos serviços descritos neste documento.');
    // Rodapé na mesma página do quadro de assinatura (sem página só com o rodapé).
    expect(documentos()[0].__paginas).toBe(1);
    expect(tudo).toContain('Orçamento nº 42 · Emitido em');
  });

  it('logo em link http ou inválida: PDF sem logo, sem erro e sem baixar nada', async () => {
    for (const logo_url of ['https://exemplo.test/logo.png', 'data:image/png;base64,nao-e-png', 'texto solto', null]) {
      documentos().length = 0;
      __limparCacheLabTenants();
      const m = montar(LAB, [LAB], orcamento(LAB), { ...CONTA, logo_url });
      const buf = await m.svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', LAB);
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
      expect([logo_url, documentos()[0].__imagens]).toEqual([logo_url, 0]);
    }
  });

  it('conta sem nome e sem dados: nome padrão do laboratório; orçamento sem número usa o id curto', async () => {
    const m = montar(LAB, [LAB], orcamento(LAB, { quote_number: 0 }), {
      name: '  ', logo_url: null, phone: null, email: null, cpf_cnpj: null, city: null, state: null,
    });
    await m.svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', LAB);
    const t = textos(documentos()[0]);
    expect(t).toEqual(expect.arrayContaining(['Laboratório', 'Nº A1B2C3D4']));
    // Sem documento da conta: só a linha do cliente traz CPF/CNPJ.
    expect(t.filter((x) => x.startsWith('CNPJ:'))).toEqual([]);
  });

  it('cliente pessoa física: CPF formatado, sem RG nem nascimento', async () => {
    const m = montar(LAB, [LAB], orcamento(LAB, { patient: cliente(LAB, { name: 'Dentista Exemplo', cpf: '52998224725' }) }));
    await m.svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', LAB);
    const tudo = textos(documentos()[0]).join('\n');
    expect(tudo).toContain('CPF/CNPJ: 529.982.247-25');
    expect(tudo).not.toMatch(/RG|Nascimento|1990/);
  });

  it('clínica (com e sem outra conta de laboratório): o desenho de sempre e a conta não é lida', async () => {
    for (const labs of [[], [LAB]]) {
      documentos().length = 0;
      __limparCacheLabTenants();
      const m = montar(CLINICA, labs, orcamento(CLINICA));
      await m.svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', CLINICA);
      const t = textos(documentos()[0]);
      expect(t).toEqual(expect.arrayContaining(['INSTITUTO ODONTO PASSOS', 'PACIENTE', 'PROCEDIMENTOS', 'Dente']));
      expect(t.join('\n')).not.toContain('CLIENTE');
      expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
      expect(m.prisma.quoteLabCase.findFirst).not.toHaveBeenCalled();
      expect(documentos()[0].__imagens).toBe(0);
    }
  });

  it('desenharOrcamentoDoLaboratorio direto, sem conta: nome padrão e PDF válido', async () => {
    const buf = await desenharOrcamentoDoLaboratorio(orcamento(LAB), null, true);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(textos(documentos()[0])).toEqual(expect.arrayContaining(['Laboratório']));
  });
});

describe('caixa da proposta de pagamento do laboratório: a mesma conta da clínica (F6)', () => {
  const casos: Array<[string, number, string, number, number]> = [
    ['pix sem desconto', 4950, 'pix', 0, 0],
    ['pix com 5% à vista', 4950, 'pix', 0, 5],
    ['boleto à vista sem desconto', 4950, 'boleto-avista', 0, 0],
    ['boleto à vista com 5%', 4950, 'boleto-avista', 0, 5],
    ['cartão 1x', 4950, 'cartao-1x', 0, 0],
    ['cartão 6x com entrada', 4950, 'cartao-6x', 950, 0],
    ['cartão 10x (com juros)', 4950, 'cartao-10x', 0, 0],
    ['cartão 12x com entrada', 4950, 'cartao-12x', 950, 0],
    ['boleto parcelado 6x', 4950, 'parcelado-6x', 0, 0],
    ['boleto parcelado 12x com entrada', 4950, 'parcelado-12x', 950, 0],
    ['boleto parcelado 24x', 4950, 'parcelado-24x', 0, 0],
    ['entrada maior que o total', 4950, 'parcelado-3x', 9999, 0],
  ];
  const numeros = (o: { headline: string; lines: string[] } | null) =>
    o ? [o.headline, ...o.lines].join(' | ').match(/\d[\d.,]*/g) : null;

  it.each(casos)('%s: mesmos valores, sem os nomes da clínica', (_rotulo, total, chave, entrada, pct) => {
    const daClinica = (new QuotePdfService({} as any) as any).buildPaymentOfferText(total, chave, entrada, pct);
    const doLab = ofertaDePagamentoDoLaboratorio(total, chave, entrada, pct);
    expect(doLab).not.toBeNull();
    expect(numeros(doLab)).toEqual(numeros(daClinica));
    expect(doLab!.lines.length).toBe(daClinica.lines.length);
    const texto = [doLab!.headline, ...doLab!.lines].join('\n');
    expect(texto).not.toMatch(/Banco PASSOS|PagBank|consulta de crédito/);
    expect(temPalavraDeClinica(texto)).toBe(false);
  });

  it('chave desconhecida: nada (como a clínica)', () => {
    expect(ofertaDePagamentoDoLaboratorio(4950, 'cheque-3x', 0, 0)).toBeNull();
  });
});
