/**
 * F1 — retrato de comportamento "clínica idêntica": o TEXTO dos PDFs que a
 * clínica entrega ao paciente.
 *
 * Congela (jest snapshot, estrito) o que é DESENHADO em cada PDF, na ordem, com
 * fonte, tamanho, cor, alinhamento e as quebras de página:
 *   1) proposta/orçamento (QuotePdfService.generatePdf), com e sem valores, e a
 *      caixa "Proposta de pagamento apresentada" de cada forma de pagamento;
 *   2) TCLE do plano (TreatmentPlanContractService.sendForSignature): o PDF que
 *      sobe pro ClickSign e a mensagem do link no WhatsApp;
 *   3) contrato odonto (ContractPdfService): o anexo gerado pelo pdfkit e o que
 *      é escrito por cima do contrato desenhado e dos termos oficiais (pdf-lib +
 *      overlay-map.json): nome/logo da clínica, paciente, dentista, valor, data.
 * O laboratório vai usar estes mesmos serviços com outros nomes (cliente,
 * protético, ordem de serviço...). Para as clínicas, cada palavra destes PDFs
 * tem que continuar igual.
 *
 * Como grava: o pdfkit é o REAL, estendido por uma subclasse (jest.mock) que
 * anota cada text() e cada página nova. Layout, quebra automática e bytes são
 * os de produção (o contrato precisa dos bytes de verdade para o pdf-lib
 * mesclar). No pdf-lib, espia drawText/drawRectangle/drawImage da página e
 * chama o original. Prisma, ClickSign e WhatsApp mockados, relógio fixo; os
 * termos oficiais são os PDFs do repositório (commercial/contract-templates).
 * O retrato é de TEXTO, não de bytes.
 *
 * Se a mudança for de propósito para as clínicas: `npx jest __guards__/pdf-text -u`
 * em apps/api, commite o .snap junto e explique no commit o que mudou no papel.
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@crm/shared';
import PDFKit from 'pdfkit';
import { PDFDocument as PDFLibDocument, PDFPage } from 'pdf-lib';
import { ContractPdfService, isPdfBuffer } from '../commercial/contract-pdf.service';
import { QuotePdfService } from '../commercial/quote-pdf.service';
import { TreatmentPlanContractService } from '../commercial/treatment-plan-contract.service';

/**
 * pdfkit real + gravador. Cada documento guarda em `__eventos` os text() (com o
 * estilo corrente) e as páginas, na ordem em que acontecem. O text() entra na
 * lista quando a 1ª linha dele é desenhada (`_fragment`, uma chamada por linha
 * no pdfkit), então fica embaixo da página onde realmente começou; se a quebra
 * automática cair no meio dele, entra a marca "continuação" na página nova.
 */
jest.mock('pdfkit', () => {
  const PDFKitReal = jest.requireActual('pdfkit');
  const eventos = (doc: any): any[] => (doc.__eventos ??= []);
  class PdfGravador extends PDFKitReal {
    static documentos: any[] = [];
    constructor(opcoes?: any) {
      super(opcoes);
      (this as any).__opcoes = opcoes;
      PdfGravador.documentos.push(this);
    }
    addPage(opcoes?: any) {
      const doc = this as any;
      doc.__paginas = (doc.__paginas ?? 0) + 1;
      const origem = doc.__paginas === 1 ? '' : doc.__quebraAuto ? ' (quebra automática)' : ' (addPage do service)';
      eventos(doc).push({ tipo: 'pagina', rotulo: `──── página ${doc.__paginas}${origem} ────` });
      return super.addPage(opcoes);
    }
    continueOnNewPage(opcoes?: any) {
      const doc = this as any;
      doc.__quebraAuto = true;
      try {
        return super.continueOnNewPage(opcoes);
      } finally {
        doc.__quebraAuto = false;
      }
    }
    text(texto: any, x?: any, y?: any, opcoes?: any) {
      const doc = this as any;
      const o = x !== null && typeof x === 'object' ? x : (opcoes ?? {});
      const ev = {
        tipo: 'texto',
        texto: String(texto),
        fonte: doc._font?.name,
        tamanho: doc._fontSize,
        cor: doc._fillColor?.[0],
        align: o.align,
        continued: !!o.continued,
        pagina: 0,
      };
      doc.__pendente = ev;
      try {
        return super.text(texto, x, y, opcoes);
      } finally {
        doc.__pendente = null;
        // Nenhuma linha desenhada (texto vazio): anota mesmo assim.
        if (!ev.pagina) eventos(doc).push(ev);
      }
    }
    _fragment(texto: any, x: any, y: any, opcoes: any) {
      const doc = this as any;
      const ev = doc.__pendente;
      if (ev && !ev.pagina) {
        ev.pagina = doc.__paginas;
        eventos(doc).push(ev);
      } else if (ev && ev.pagina !== doc.__paginas) {
        ev.pagina = doc.__paginas;
        eventos(doc).push({ tipo: 'continuacao' });
      }
      return super._fragment(texto, x, y, opcoes);
    }
  }
  return { __esModule: true, default: PdfGravador };
});

const TENANT = '00000000-0000-0000-0000-0000000000c1';
const AGORA = new Date('2026-10-20T15:00:00.000Z');
const D = (v: string) => new Prisma.Decimal(v);
// PNG 1x1 (logo de exemplo da clínica, como data URI — é assim que o Tenant guarda).
const LOGO_PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ─── leitura do que foi desenhado ────────────────────────────────────────────

const documentosPdfkit = (): any[] => (PDFKit as any).documentos;
const PRETO = new Set<any>([undefined, null, 'black', '#000', '#000000']);

/** Linhas legíveis: `[fonte tamanho cor alinhamento] texto` e marcadores de página. */
function linhasDoPdf(doc: any): string[] {
  // Texto com conteúdo e sem página = o pdfkit parou de chamar `_fragment`
  // (versão nova?): o gravador precisa de ajuste antes de confiar no retrato.
  const semPagina = (doc.__eventos as any[]).filter((e) => e.tipo === 'texto' && !e.pagina && e.texto.trim());
  expect(semPagina).toEqual([]);
  return (doc.__eventos as any[]).map((e) => {
    if (e.tipo === 'pagina') return e.rotulo;
    if (e.tipo === 'continuacao') return '[…] continuação do texto anterior';
    const estilo = [e.fonte, e.tamanho, PRETO.has(e.cor) ? null : e.cor, e.align ?? null, e.continued ? 'continua→' : null]
      .filter((x) => x !== null && x !== undefined)
      .join(' ');
    return `[${estilo}] ${e.texto}`;
  });
}

/** As linhas agrupadas por página (para retratar onde a página quebra). */
function porPagina(linhas: string[]) {
  const paginas: Array<{ pagina: string; linhas: string[] }> = [];
  for (const l of linhas) {
    if (l.startsWith('──── página')) paginas.push({ pagina: l, linhas: [] });
    else paginas[paginas.length - 1].linhas.push(l);
  }
  return paginas;
}

const num = (v: number) => Math.round(v * 100) / 100;
function corPdfLib(c: any): string {
  if (!c || (c.red === 0 && c.green === 0 && c.blue === 0)) return '';
  return ` rgb(${num(c.red)},${num(c.green)},${num(c.blue)})`;
}

/**
 * Espia o que o pdf-lib escreve nas páginas (chama o original; só anota o que
 * deu certo — o drawOverlayField tenta de novo sem os caracteres fora do
 * WinAnsi quando o 1º drawText lança).
 */
function gravarPdfLib(): string[] {
  const registro: string[] = [];
  const pagina = (p: any) => `p${p.doc.getPages().indexOf(p) + 1}`;
  const proto = PDFPage.prototype as any;
  const drawText = proto.drawText;
  const drawRectangle = proto.drawRectangle;
  const drawImage = proto.drawImage;
  jest.spyOn(proto, 'drawText').mockImplementation(function (this: any, texto: any, o: any = {}) {
    const r = drawText.call(this, texto, o);
    registro.push(`${pagina(this)} (${num(o.x)}, ${num(o.y)}) ${o.font?.name} ${num(o.size)}${corPdfLib(o.color)} · ${texto}`);
    return r;
  });
  jest.spyOn(proto, 'drawRectangle').mockImplementation(function (this: any, o: any = {}) {
    const r = drawRectangle.call(this, o);
    registro.push(`${pagina(this)} retângulo (${num(o.x)}, ${num(o.y)}) ${num(o.width)}×${num(o.height)}${corPdfLib(o.color) || ' rgb(0,0,0)'}`);
    return r;
  });
  jest.spyOn(proto, 'drawImage').mockImplementation(function (this: any, img: any, o: any = {}) {
    const r = drawImage.call(this, img, o);
    registro.push(`${pagina(this)} imagem ${img?.width}x${img?.height}px em (${num(o.x)}, ${num(o.y)}) ${num(o.width)}×${num(o.height)}`);
    return r;
  });
  return registro;
}

/** Erros/avisos do Logger do Nest (silenciados; o teste confere que não houve). */
function silenciarLogger() {
  const avisos: string[] = [];
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => void avisos.push(`warn: ${m}`));
  jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => void avisos.push(`error: ${m}`));
  return avisos;
}

// ─── dados de exemplo (nada real) ────────────────────────────────────────────

function paciente(over: Record<string, any> = {}) {
  return {
    id: 'pac-exemplo-1',
    name: 'Maria Exemplo da Silva',
    cpf: '000.000.000-00',
    rg: '0000000 SSP/AL',
    // Meio-dia UTC: a data impressa é a mesma em UTC e em America/Sao_Paulo.
    birth_date: new Date('1990-05-12T12:00:00.000Z'),
    phone: '5582900000001',
    email: 'maria@exemplo.test',
    tenant_id: TENANT,
    address: 'Rua Exemplo',
    address_number: '100',
    neighborhood: 'Centro',
    city: 'Cidade Exemplo',
    state: 'AL',
    zip_code: '57000-000',
    ...over,
  };
}

const DENTISTA_ITEM = { id: 'u-dent-1', name: 'Dr. Exemplo Implantodontista', cro_number: 'CRO-AL 00001', cro_uf: 'AL' };

function itensDaProposta() {
  return [
    {
      id: 'qi-1', tooth_fdi: '16', quantity: 1, unit_price: D('3500.00'), total_price: D('3500.00'),
      notes: 'Implante cone morse', order_index: 0,
      procedure: { name: 'Implante dentário', code_tuss: '00000001', specialty: { name: 'Implantodontia' } },
      dentist: DENTISTA_ITEM,
    },
    {
      id: 'qi-2', tooth_fdi: '16', quantity: 1, unit_price: D('1500.00'), total_price: D('1500.00'),
      notes: null, order_index: 1,
      procedure: { name: 'Coroa sobre implante', code_tuss: null, specialty: { name: 'Implantodontia' } },
      dentist: DENTISTA_ITEM,
    },
    {
      id: 'qi-3', tooth_fdi: null, quantity: 2, unit_price: D('250.00'), total_price: D('500.00'),
      notes: null, order_index: 2,
      procedure: { name: 'Restauração em resina', code_tuss: null, specialty: { name: 'Dentística' } },
      dentist: null,
    },
  ];
}

/** Proposta completa (o include do QuotePdfService e do ContractPdfService). */
function proposta(over: Record<string, any> = {}) {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    quote_number: 42,
    title: 'Reabilitação superior',
    status: 'ACCEPTED',
    created_at: new Date('2026-10-18T14:00:00.000Z'),
    valid_until: new Date('2026-11-17T15:00:00.000Z'),
    subtotal: D('5500.00'),
    discount_percent: D('10.00'),
    discount_value: D('550.00'),
    total_value: D('4950.00'),
    payment_terms: 'Entrada + 12x no boleto',
    chosen_payment_key: 'parcelado-12x',
    chosen_down_payment: D('950.00'),
    avista_discount_enabled: false,
    avista_discount_pct: D('0.00'),
    notes: 'Retorno em 7 dias após a cirurgia.',
    patient: paciente(),
    created_by: { name: 'Recepção Exemplo', cro_number: null, cro_uf: null },
    items: itensDaProposta(),
    attachments: [
      { id: 'att-1', filename: 'panoramica.jpg', category: 'RADIOGRAFIA', mime_type: 'image/jpeg' },
      { id: 'att-2', filename: 'plano-de-tratamento.pdf', category: null, mime_type: 'application/pdf' },
    ],
    ...over,
  };
}

/** Clínica com a Identidade toda preenchida (Configurações › Identidade). */
const CLINICA = {
  name: 'Clínica Exemplo',
  cpf_cnpj: '00.000.000/0001-00',
  phone: '5582900000002',
  email: 'contato@clinica-exemplo.test',
  address: 'Rua das Flores',
  address_number: '200',
  address_complement: 'Sala 3',
  neighborhood: 'Centro',
  city: 'Cidade Exemplo',
  state: 'AL',
  zip_code: '57000-000',
  responsible_name: 'Dra. Responsável Exemplo',
  responsible_cro: '00000-AL',
  logo_url: LOGO_PNG_1X1,
};

// ─── relógio fixo ────────────────────────────────────────────────────────────

beforeEach(() => {
  // Só o relógio é falso (datas impressas); promessas e streams do pdfkit seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  documentosPdfkit().length = 0;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ─── 1. Proposta / orçamento ─────────────────────────────────────────────────

describe('retrato: PDF da proposta (QuotePdfService) (F1)', () => {
  function montar(quote: any) {
    const prisma: any = { quote: { findUnique: jest.fn().mockResolvedValue(quote) } };
    return { svc: new QuotePdfService(prisma), prisma };
  }

  it('com valores: cabeçalho, paciente, tabela, totais, condições, proposta de pagamento, anexos, assinatura e rodapé', async () => {
    const { svc, prisma } = montar(proposta());
    const buf = await svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', TENANT);

    expect(isPdfBuffer(buf)).toBe(true);
    expect(prisma.quote.findUnique.mock.calls[0][0].where).toEqual({ id: 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(documentosPdfkit()).toHaveLength(1);
    const [doc] = documentosPdfkit();
    expect(doc.__opcoes).toMatchSnapshot('new PDFDocument (opções e metadados)');
    expect(linhasDoPdf(doc)).toMatchSnapshot('texto desenhado');
  });

  it('sem valores (o PDF que vai junto do plano): só procedimentos, sem totais nem pagamento', async () => {
    const { svc } = montar(proposta());
    await svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', TENANT, false);

    const linhas = linhasDoPdf(documentosPdfkit()[0]);
    expect(linhas.join('\n')).not.toMatch(/R\$|TOTAL|PAGAMENTO/);
    expect(linhas).toMatchSnapshot('texto desenhado');
  });

  it('proposta mínima (sem validade, sem atendente, paciente só com nome, sem forma de pagamento)', async () => {
    const { svc } = montar(
      proposta({
        valid_until: null,
        created_by: null,
        patient: paciente({
          cpf: null, rg: null, phone: null, email: null, address: null, address_number: null,
          neighborhood: null, city: null, state: null,
        }),
        discount_value: D('0.00'),
        discount_percent: D('0.00'),
        total_value: D('5500.00'),
        payment_terms: null,
        chosen_payment_key: null,
        notes: null,
        attachments: [],
      }),
    );
    await svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', TENANT);
    expect(linhasDoPdf(documentosPdfkit()[0])).toMatchSnapshot('texto desenhado');
  });

  it('proposta longa: onde a página quebra e o cabeçalho da tabela repetido', async () => {
    const muitos = Array.from({ length: 26 }, (_, i) => ({
      id: `qi-${i + 1}`, tooth_fdi: String(11 + (i % 8)), quantity: 1,
      unit_price: D('180.00'), total_price: D('180.00'), notes: null, order_index: i,
      procedure: { name: `Procedimento de exemplo ${i + 1}`, code_tuss: null },
    }));
    const { svc } = montar(proposta({ items: muitos, subtotal: D('4680.00'), total_value: D('4130.00') }));
    await svc.generatePdf('a1b2c3d4-0000-4000-8000-000000000001', TENANT);

    const paginas = porPagina(linhasDoPdf(documentosPdfkit()[0]));
    expect(paginas.length).toBeGreaterThan(1);
    expect(
      paginas.map((p) => ({
        pagina: p.pagina,
        total_de_textos: p.linhas.length,
        primeiros: p.linhas.slice(0, 7),
        ultimos: p.linhas.slice(-3),
      })),
    ).toMatchSnapshot('páginas');
  });

  it('caixa "Proposta de pagamento apresentada": texto de cada forma de pagamento', () => {
    const svc: any = new QuotePdfService({} as any);
    const casos: Array<[string, number, string, number, number]> = [
      // [rótulo, total, chosen_payment_key, entrada, % à vista]
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
      ['chave desconhecida', 4950, 'cheque-3x', 0, 0],
    ];
    const tabela = Object.fromEntries(
      casos.map(([rotulo, total, chave, entrada, pct]) => [
        `${rotulo} (${chave})`,
        svc.buildPaymentOfferText(total, chave, entrada, pct),
      ]),
    );
    expect(tabela['chave desconhecida (cheque-3x)']).toBeNull();
    expect(tabela).toMatchSnapshot();
  });
});

// ─── 2. TCLE do plano de tratamento ──────────────────────────────────────────

describe('retrato: TCLE do plano (TreatmentPlanContractService) (F1)', () => {
  function plano(over: Record<string, any> = {}) {
    return {
      id: 'plano-exemplo-1',
      status: 'PENDING_SIGNATURE',
      contract_signature_id: null,
      total_value: D('5500.00'),
      patient: { ...paciente(), lead_id: 'lead-exemplo-1' },
      items: [
        { tooth_fdi: '16', quantity: 1, unit_price: D('3500.00'), total_price: D('3500.00'), procedure: { name: 'Implante dentário' } },
        { tooth_fdi: '16', quantity: 1, unit_price: D('1500.00'), total_price: D('1500.00'), procedure: { name: 'Coroa sobre implante' } },
        { tooth_fdi: null, quantity: 2, unit_price: D('250.00'), total_price: D('500.00'), procedure: null },
      ],
      ...over,
    };
  }

  function montar(plan: any, nomeClinica: string | null) {
    const prisma: any = {
      treatmentPlan: {
        findUnique: jest.fn().mockResolvedValue(plan),
        update: jest.fn().mockResolvedValue({}),
      },
      tenant: { findUnique: jest.fn().mockResolvedValue(nomeClinica === null ? null : { name: nomeClinica }) },
    };
    const clicksign: any = {
      createGenericSignature: jest.fn().mockResolvedValue({
        signingUrl: 'https://assinatura.exemplo.test/tcle-1',
        contractSignatureId: 'sig-exemplo-1',
      }),
    };
    const messages: any = {
      resolvePatientChips: jest.fn().mockResolvedValue(['chip-clinica-exemplo']),
      assertPatientSendable: jest.fn().mockResolvedValue(undefined),
      sendPatientText: jest.fn().mockResolvedValue({}),
    };
    const conversations: any = {
      findOrCreatePatientConversationId: jest.fn().mockResolvedValue('conv-paciente-1'),
    };
    const svc = new TreatmentPlanContractService(prisma, clicksign, messages, conversations);
    return { svc, prisma, clicksign, messages };
  }

  it('PDF do TCLE + o que vai pro ClickSign + a mensagem do link no WhatsApp', async () => {
    const avisos = silenciarLogger();
    const { svc, clicksign, messages } = montar(plano(), '  Clínica Exemplo ');
    const r = await svc.sendForSignature('plano-exemplo-1', TENANT);

    expect(avisos).toEqual([]);
    expect(r).toEqual({ signingUrl: 'https://assinatura.exemplo.test/tcle-1', whatsappSent: true });
    expect(documentosPdfkit()).toHaveLength(1);
    const [doc] = documentosPdfkit();
    expect(doc.__opcoes).toMatchSnapshot('new PDFDocument (opções e metadados)');
    expect(linhasDoPdf(doc)).toMatchSnapshot('texto desenhado');

    const [assinatura] = clicksign.createGenericSignature.mock.calls[0];
    expect(isPdfBuffer(assinatura.buffer)).toBe(true);
    expect({ ...assinatura, buffer: '<PDF do TCLE>' }).toMatchSnapshot('ClickSign.createGenericSignature');

    expect(messages.sendPatientText).toHaveBeenCalledTimes(1);
    expect(messages.sendPatientText.mock.calls[0][0]).toMatchSnapshot('WhatsApp: mensagem do link');
  });

  it('paciente com o mínimo (sem CPF, RG, nascimento e e-mail) e clínica sem nome', async () => {
    silenciarLogger();
    const p = { ...paciente({ cpf: null, rg: null, birth_date: null, email: null }), lead_id: 'lead-exemplo-1' };
    const { svc, clicksign, messages } = montar(plano({ patient: p }), null);
    await svc.sendForSignature('plano-exemplo-1', TENANT);

    const linhas = linhasDoPdf(documentosPdfkit()[0]);
    expect(linhas.slice(0, 12)).toMatchSnapshot('cabeçalho e identificação');
    expect(clicksign.createGenericSignature.mock.calls[0][0].signerEmail).toBe('5582900000001@noreply.placeholder');
    expect(messages.sendPatientText.mock.calls[0][0].text).toMatchSnapshot('WhatsApp: mensagem sem nome de clínica');
  });
});

// ─── 3. Contrato odonto ──────────────────────────────────────────────────────

describe('retrato: contrato odonto (ContractPdfService) (F1)', () => {
  function montar(opts: { contrato?: any; quote?: any; clinica?: any; dentistaEscolhido?: any }) {
    const prisma: any = {
      contract: { findUnique: jest.fn().mockResolvedValue(opts.contrato ?? null) },
      quote: { findUnique: jest.fn().mockResolvedValue(opts.quote ?? null) },
      tenant: { findUnique: jest.fn().mockResolvedValue(opts.clinica ?? null) },
      user: { findFirst: jest.fn().mockResolvedValue(opts.dentistaEscolhido ?? null) },
    };
    return { svc: new ContractPdfService(prisma), prisma };
  }

  /** O rodapé leva a hora local do servidor; o retrato troca pela marca (e confere que era AGORA). */
  function semHoraLocal(linhas: string[]): string[] {
    const hora = AGORA.toLocaleString('pt-BR');
    const rodapes = linhas.filter((l) => l.includes(' · Gerado em '));
    expect(rodapes).toHaveLength(1);
    expect(rodapes[0]).toContain(`Gerado em ${hora}`);
    return linhas.map((l) => l.split(hora).join('<AGORA em pt-BR, fuso do servidor>'));
  }

  it('contrato criado (IMPLANTE) com termos marcados: anexo gerado + contrato desenhado e termos preenchidos', async () => {
    const avisos = silenciarLogger();
    const desenhos = gravarPdfLib();
    const contrato = {
      id: 'c0ffee00-0000-4000-8000-000000000001',
      status: 'SENT',
      template_type: 'IMPLANTE',
      // TCLE vai como seção fixa; USO_IMAGEM/IMPLANTE têm PDF oficial; GARANTIA vira seção de texto.
      selected_documents: ['TCLE', 'USO_IMAGEM', 'GARANTIA', 'IMPLANTE'],
      quote: proposta(),
      dentist: null,
    };
    const { svc, prisma } = montar({ contrato, clinica: CLINICA });
    const buf = await svc.generatePdf(contrato.id, TENANT);

    expect(avisos).toEqual([]);
    expect(isPdfBuffer(buf)).toBe(true);
    expect(prisma.tenant.findUnique.mock.calls[0][0].where).toEqual({ id: TENANT });

    expect(documentosPdfkit()).toHaveLength(1);
    const [doc] = documentosPdfkit();
    expect(doc.__opcoes).toMatchSnapshot('new PDFDocument do anexo (opções e metadados)');
    expect(semHoraLocal(linhasDoPdf(doc))).toMatchSnapshot('anexo gerado (pdfkit): texto desenhado');
    expect(desenhos).toMatchSnapshot('pdf-lib: escrito sobre o contrato desenhado e os termos');

    const final = await PDFLibDocument.load(buf);
    expect({ paginas_no_pdf_final: final.getPageCount(), paginas_do_anexo_gerado: doc.__paginas }).toMatchSnapshot(
      'composição',
    );
  });

  it('pré-visualização (antes de criar): template inferido, dentista escolhido e rodapé de prévia', async () => {
    const avisos = silenciarLogger();
    const desenhos = gravarPdfLib();
    const { svc, prisma } = montar({
      quote: proposta(),
      clinica: CLINICA,
      dentistaEscolhido: { name: 'Dra. Exemplo Escolhida', cro_number: '00002-AL', cro_uf: 'AL' },
    });
    // Repetido e não-string: o service limpa (dedup, só strings).
    const buf = await svc.generatePreviewForQuote(
      'a1b2c3d4-0000-4000-8000-000000000001', TENANT, ['RESPONSAVEL_LEGAL', 'CLAREAMENTO', 'CLAREAMENTO', 42 as any], 'u-dent-2',
    );

    expect(avisos).toEqual([]);
    expect(isPdfBuffer(buf)).toBe(true);
    expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'u-dent-2', tenant_id: TENANT });
    expect(semHoraLocal(linhasDoPdf(documentosPdfkit()[0]))).toMatchSnapshot('anexo gerado (pdfkit): texto desenhado');
    expect(desenhos).toMatchSnapshot('pdf-lib: escrito sobre o contrato desenhado e os termos');
  });

  it('clínica sem Identidade preenchida, sem dentista com CRO e contrato CANCELADO: textos padrão', async () => {
    const avisos = silenciarLogger();
    const desenhos = gravarPdfLib();
    const quote = proposta({
      items: itensDaProposta().map((i) => ({ ...i, dentist: null })),
      payment_terms: null,
      title: null,
      quote_number: 0,
    });
    const contrato = {
      id: 'c0ffee00-0000-4000-8000-000000000002',
      status: 'CANCELLED',
      template_type: 'CLINICO_BASICO',
      selected_documents: [],
      quote,
      dentist: null,
    };
    const { svc } = montar({ contrato, clinica: { name: '  ' } });
    await svc.generatePdf(contrato.id, TENANT);

    expect(avisos).toEqual([]);
    expect(semHoraLocal(linhasDoPdf(documentosPdfkit()[0]))).toMatchSnapshot('anexo gerado (pdfkit): texto desenhado');
    expect(desenhos).toMatchSnapshot('pdf-lib: escrito sobre o contrato desenhado');
  });
});
