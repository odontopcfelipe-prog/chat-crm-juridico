/**
 * Laboratório — contrato de prestação de serviços de prótese dentária.
 *
 * Confere: o texto do modelo (sem vocabulário de clínica), o checklist de dados que
 * faltam, o PDF do contrato e do modelo de exemplo, a leitura SÓ da conta do token e a
 * clínica igual. Sem banco: o Prisma é um dublê com dados de exemplo (repositório público).
 */
import { NotFoundException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { __limparCacheLabTenants } from '@crm/shared';
import { ContractPdfService } from './contract-pdf.service';
import { ContractsService } from './contracts.service';
import {
  avaliarCompletudeDoLaboratorio,
  carregarPartesDoLaboratorio,
  type PartesDoContratoLab,
} from './contrato-laboratorio';
import { LAB_CONTRATO_MSG, LAB_CONTRATO_PDF } from './lab-contrato-textos';

const LAB = 'conta-lab-exemplo';
const OUTRO_LAB = 'conta-lab-outra';
const CLINICA = 'conta-clinica-exemplo';

// Mesma lista da trava 2 do CI (scripts/ci/check-pick-literals.mjs).
const PROIBIDOS = [
  /(?<![\p{L}\p{N}])(?:pacientes?)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:consultas?)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:prontuarios?)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:anamneses?)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:odontogramas?)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:planos? de tratamentos?)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:tratamentos? odontologicos?)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:tcle)(?![\p{L}\p{N}])/u,
];
const PERMITIDO = /(?<![\p{L}\p{N}])(?:pacientes? do caso)(?![\p{L}\p{N}])/gu;
function termosProibidos(texto: string): string[] {
  const t = texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').replace(PERMITIDO, ' ');
  return PROIBIDOS.filter((re) => re.test(t)).map((re) => re.source);
}

function textosDoModelo(): string[] {
  const c = LAB_CONTRATO_PDF.clausulas({
    numeroOrcamento: '42', valor: '1.000,00', valorExtenso: 'mil reais', pagamento: 'PIX', foro: 'Cidade/UF',
  });
  const estaticos = (Object.values(LAB_CONTRATO_PDF) as unknown[]).filter((v): v is string => typeof v === 'string');
  const mensagens = (Object.values(LAB_CONTRATO_MSG) as unknown[]).filter((v): v is string => typeof v === 'string');
  return [
    ...estaticos,
    ...mensagens,
    LAB_CONTRATO_MSG.legenda('Fulano', 'Laboratório Exemplo'),
    LAB_CONTRATO_MSG.faltamDados('Nome do cliente'),
    LAB_CONTRATO_MSG.telefoneDiferente('1111', '2222'),
    ...c.flatMap((x) => [x.titulo, ...x.paragrafos]),
  ];
}

const TENANT_LAB = {
  name: 'Laboratório Exemplo Ltda', cpf_cnpj: '11222333000181', phone: '5582900000010', email: 'lab@exemplo.test',
  logo_url: null, address: 'Rua Exemplo', address_number: '100', address_complement: null, neighborhood: 'Centro',
  city: 'Maceió', state: 'AL', zip_code: '57000000', responsible_name: 'Responsável da Identidade', responsible_cro: 'CRO-AL 999',
};

type Montagem = {
  labs?: string[];
  tenant?: any;
  perfil?: any;
  ficha?: any;
  specs?: any[];
  quote?: any;
};

function montar(o: Montagem = {}) {
  __limparCacheLabTenants();
  const chamadas: Array<[string, any]> = [];
  const prisma: any = {
    tenantBusinessProfile: {
      findMany: jest.fn(async () => (o.labs ?? [LAB]).map((tenant_id) => ({ tenant_id }))),
      findUnique: jest.fn(async (a: any) => (chamadas.push(['perfil', a]), o.perfil === undefined ? { lab_cro_inscricao: 'LB-123', rt_name: 'Protético Responsável', rt_cro: 'TPD-AL 456' } : o.perfil)),
    },
    tenant: { findUnique: jest.fn(async (a: any) => (chamadas.push(['tenant', a]), o.tenant === undefined ? TENANT_LAB : o.tenant)) },
    patientLabProfile: {
      findFirst: jest.fn(async (a: any) => (chamadas.push(['ficha', a]), o.ficha === undefined
        ? { kind: 'DENTISTA', cro_number: '12345', cro_uf: 'AL', legal_name: null, clinic_name: null, contact_name: null }
        : o.ficha)),
    },
    procedureLabSpec: {
      findMany: jest.fn(async (a: any) => (chamadas.push(['specs', a]), o.specs ?? [{ procedure_id: 'proc-1', lead_time_days: 7, warranty_days: 365 }])),
    },
    user: { findFirst: jest.fn(async () => null) },
    quote: {
      findUnique: jest.fn(async (a: any) => (chamadas.push(['quote', a]), o.quote ?? quoteExemplo(LAB))),
    },
  };
  return { prisma, chamadas, svc: new ContractPdfService(prisma) };
}

function quoteExemplo(conta: string, over: Record<string, any> = {}) {
  return {
    id: 'orc-1', quote_number: 42, total_value: 1550.5, payment_terms: 'PIX à vista',
    patient: {
      id: 'cli-1', name: 'Dr. Cliente Exemplo', cpf: '12345678909', phone: '5582900000001', email: 'cliente@exemplo.test',
      address: 'Rua do Cliente', address_number: '10', neighborhood: 'Bairro', city: 'Maceió', state: 'AL', zip_code: '57000001',
      tenant_id: conta,
    },
    items: [
      { id: 'qi-1', procedure_id: 'proc-1', procedure: { name: 'Coroa de zircônia', code_tuss: null }, tooth_fdi: '11', quantity: 1, total_price: 1550.5, notes: 'cor A2', dentist: null },
    ],
    created_by: null,
    ...over,
  };
}

describe('texto do contrato do laboratório (modelo inicial)', () => {
  it('nenhum termo de clínica no texto (mesma regra da trava 2 do CI)', () => {
    const textos = textosDoModelo();
    expect(textos.length).toBeGreaterThan(40);
    for (const t of textos) expect([t, termosProibidos(t)]).toEqual([t, []]);
  });

  it('cobre objeto, prazo, garantia e retrabalho, pagamento, arquivos, LGPD e foro', () => {
    const titulos = LAB_CONTRATO_PDF.clausulas({ numeroOrcamento: '1', valor: '1,00', valorExtenso: 'um real', pagamento: null, foro: 'Maceió/AL' })
      .map((c) => c.titulo).join(' | ');
    for (const parte of ['DO OBJETO', 'DO PRAZO', 'DA GARANTIA E DO RETRABALHO', 'DO PREÇO E DO PAGAMENTO', 'DOS ARQUIVOS', 'LGPD', 'DO FORO']) {
      expect(titulos).toContain(parte);
    }
  });

  it('o foro e o valor entram no texto; sem forma de pagamento, remete ao orçamento', () => {
    const c = LAB_CONTRATO_PDF.clausulas({ numeroOrcamento: '7', valor: '2.000,00', valorExtenso: 'dois mil reais', pagamento: null, foro: 'Maceió/AL' });
    const texto = c.flatMap((x) => x.paragrafos).join('\n');
    expect(texto).toContain('foro da comarca de Maceió/AL');
    expect(texto).toContain('R$ 2.000,00 (dois mil reais)');
    expect(texto).toContain('a condição aprovada no orçamento nº 7');
  });
});

describe('checklist de dados do contrato do laboratório', () => {
  it('conta completa: nada falta; o responsável que assina é o do perfil do laboratório', async () => {
    const m = montar();
    const r = await m.svc.assessCompleteness('orc-1', LAB);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.dentist).toEqual({ name: 'Protético Responsável', cro: 'TPD-AL 456' });
    expect(r.items.map((i) => i.key)).toContain('patient_cro');
  });

  it('o rótulo fala do cliente e do laboratório, nunca do paciente nem da clínica', async () => {
    const m = montar({ tenant: { ...TENANT_LAB, cpf_cnpj: null, city: null }, ficha: null, quote: quoteExemplo(LAB, { patient: { ...quoteExemplo(LAB).patient, cpf: null } }) });
    const r = await m.svc.assessCompleteness('orc-1', LAB);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['CPF ou CNPJ do cliente', 'CNPJ do laboratório', 'Cidade do laboratório (foro do contrato)']));
    for (const t of r.items.map((i) => i.label)) expect([t, termosProibidos(t)]).toEqual([t, []]);
  });

  it('CRO do cliente é obrigatório só quando a ficha diz dentista', async () => {
    const dentistaSemCro = montar({ ficha: { kind: 'DENTISTA', cro_number: null, cro_uf: null, legal_name: null, clinic_name: null, contact_name: null } });
    expect((await dentistaSemCro.svc.assessCompleteness('orc-1', LAB)).missing).toEqual(['CRO do cliente']);
    const clinicaSemCro = montar({ ficha: { kind: 'CLINICA', cro_number: null, cro_uf: null, legal_name: 'Clínica Exemplo Ltda', clinic_name: null, contact_name: null } });
    expect((await clinicaSemCro.svc.assessCompleteness('orc-1', LAB)).complete).toBe(true);
  });

  it('sem o responsável técnico no perfil, usa o da Identidade; sem nenhum, bloqueia', async () => {
    const daIdentidade = montar({ perfil: { lab_cro_inscricao: null, rt_name: null, rt_cro: null } });
    expect((await daIdentidade.svc.assessCompleteness('orc-1', LAB)).dentist).toEqual({ name: 'Responsável da Identidade', cro: 'CRO-AL 999' });
    const nenhum = montar({ perfil: null, tenant: { ...TENANT_LAB, responsible_name: null, responsible_cro: null } });
    expect((await nenhum.svc.assessCompleteness('orc-1', LAB)).missing).toEqual([
      'Nome do responsável técnico do laboratório',
      'CRO do responsável técnico do laboratório',
    ]);
  });

  it('valor zero bloqueia', async () => {
    const m = montar({ quote: quoteExemplo(LAB, { total_value: 0 }) });
    expect((await m.svc.assessCompleteness('orc-1', LAB)).missing).toEqual(['Valor do orçamento']);
  });

  it('orçamento de outra conta: recusa antes de ler o laboratório', async () => {
    const m = montar({ labs: [LAB, OUTRO_LAB], quote: quoteExemplo(OUTRO_LAB) });
    await expect(m.svc.assessCompleteness('orc-1', LAB)).rejects.toThrow('Orcamento de outro tenant');
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(m.prisma.patientLabProfile.findFirst).not.toHaveBeenCalled();
  });

  it('clínica: o mesmo checklist de sempre (paciente, clínica, dentista), sem tocar na ficha do laboratório', async () => {
    const m = montar({
      labs: [LAB],
      tenant: { ...TENANT_LAB, name: 'Clínica Exemplo', responsible_name: 'Dra. Exemplo', responsible_cro: 'CRO-AL 1' },
      quote: {
        ...quoteExemplo(CLINICA), items: [], created_by: null,
        patient: { ...quoteExemplo(CLINICA).patient },
      },
    });
    const r = await m.svc.assessCompleteness('orc-1', CLINICA);
    expect(r.items.map((i) => i.label)).toContain('Nome do paciente');
    expect(r.items.map((i) => i.label)).toContain('CNPJ da clínica');
    expect(m.prisma.patientLabProfile.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.procedureLabSpec.findMany).not.toHaveBeenCalled();
  });
});

describe('PDF do contrato do laboratório', () => {
  function contrato(conta: string, over: Record<string, any> = {}) {
    return { id: 'contrato-1', status: 'DRAFT', template_type: 'LABORATORIO', selected_documents: [], dentist: null, quote: quoteExemplo(conta), ...over };
  }

  it('gera um PDF válido com contrato e anexo, lendo só a conta do token', async () => {
    const m = montar();
    const pdf = await (m.svc as any).buildPdf(contrato(LAB), LAB);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3); // cláusulas (2+) e o anexo
    // Toda leitura de dados da conta vai com a conta do token.
    const tenant = m.chamadas.filter(([k]) => k === 'tenant').map(([, a]) => a.where.id);
    expect(tenant).toEqual([LAB]);
    expect(m.chamadas.find(([k]) => k === 'perfil')![1].where).toEqual({ tenant_id: LAB });
    expect(m.chamadas.find(([k]) => k === 'ficha')![1].where).toEqual({ patient_id: 'cli-1', tenant_id: LAB });
    expect(m.chamadas.find(([k]) => k === 'specs')![1].where).toEqual({ tenant_id: LAB, procedure_id: { in: ['proc-1'] } });
  });

  it('gera também sem ficha do cliente, sem prazos e sem pagamento', async () => {
    const m = montar({ ficha: null, specs: [], perfil: null });
    const q = quoteExemplo(LAB, { payment_terms: null });
    const pdf = await (m.svc as any).buildPdf(contrato(LAB, { quote: q }), LAB);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('o nome que assina pelo laboratório pode ser o usuário escolhido, com CRO', async () => {
    const m = montar();
    const partes = await carregarPartesDoLaboratorio(m.prisma, LAB, quoteExemplo(LAB).patient, { name: 'Técnico Escolhido', cro_number: '777', cro_uf: 'AL' });
    expect(partes.contratada.responsavelNome).toBe('Técnico Escolhido');
    expect(partes.contratada.responsavelCro).toBe('CRO-AL 777');
  });

  it('cliente clínica: razão social da ficha e representante', async () => {
    const m = montar({ ficha: { kind: 'CLINICA', cro_number: null, cro_uf: null, legal_name: 'Clínica Exemplo Ltda', clinic_name: null, contact_name: 'Fulano Exemplo' } });
    const partes: PartesDoContratoLab = await carregarPartesDoLaboratorio(m.prisma, LAB, { ...quoteExemplo(LAB).patient, cpf: '11222333000181' }, null);
    expect(partes.cliente.nome).toBe('Clínica Exemplo Ltda');
    expect(partes.cliente.representante).toBe('Fulano Exemplo');
    expect(partes.cliente.documento).toBe('11.222.333/0001-81');
    expect(avaliarCompletudeDoLaboratorio(partes, 100).complete).toBe(true);
  });
});

describe('modelo de exemplo (tela de configuração)', () => {
  it('laboratório: PDF de exemplo com os dados da própria conta e marca de modelo', async () => {
    const m = montar();
    const pdf = await m.svc.readTemplatePdfParaConta('MODELO_LABORATORIO', LAB);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(m.prisma.tenant.findUnique.mock.calls.map((c: any[]) => c[0].where.id)).toEqual([LAB]);
    expect(m.prisma.patientLabProfile.findFirst).not.toHaveBeenCalled();
  });

  it('laboratório: os termos da clínica são negados (VERTICAL_DENIED), sem ler o disco', async () => {
    const m = montar();
    const leitura = jest.spyOn(m.svc, 'readTemplatePdf');
    await expect(m.svc.readTemplatePdfParaConta('USO_IMAGEM', LAB)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VERTICAL_DENIED' }),
    });
    expect(leitura).not.toHaveBeenCalled();
  });

  it('clínica: o id do modelo não existe (404 de sempre)', async () => {
    const m = montar({ labs: [LAB] });
    await expect(m.svc.readTemplatePdfParaConta('MODELO_LABORATORIO', CLINICA)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clínica: um termo de sempre segue pelo caminho de sempre', async () => {
    const m = montar({ labs: [LAB] });
    const pdf = await m.svc.readTemplatePdfParaConta('USO_IMAGEM', CLINICA);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});

describe('criar, enviar e assinar o contrato — laboratório e clínica', () => {
  function banco(conta: string, status = 'DRAFT') {
    __limparCacheLabTenants();
    const criados: any[] = [];
    const atualizados: any[] = [];
    const contrato = {
      id: 'contrato-1', quote_id: 'orc-1', status, skipped: false, template_type: conta === LAB ? 'LABORATORIO' : 'CLINICO_BASICO',
      quote: { patient: { tenant_id: conta } }, events: [],
    };
    const prisma: any = {
      tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
      quote: {
        findUnique: jest.fn(async () => ({
          id: 'orc-1', status: 'ACCEPTED', patient: { id: 'cli-1', tenant_id: conta }, contract: null,
          items: [{ procedure: { specialty: { name: 'IMPLANTE' } } }],
        })),
      },
      user: { findFirst: jest.fn(async () => null) },
      contract: {
        findUnique: jest.fn(async () => contrato),
        create: jest.fn(async (a: any) => (criados.push(a.data), { id: 'contrato-1', ...a.data })),
        update: jest.fn(async (a: any) => (atualizados.push(a.data), { ...contrato, ...a.data })),
      },
    };
    const pdf: any = { assessCompleteness: jest.fn(async () => ({ complete: true, missing: [] })) };
    return { svc: new ContractsService(prisma, pdf), prisma, pdf, criados, atualizados };
  }

  it('laboratório: cria o contrato do laboratório (modelo próprio), sem termos extras e sem inferir especialidade da clínica', async () => {
    const m = banco(LAB);
    await m.svc.createForQuote('orc-1', LAB, 'usuario-1', { selected_documents: ['TCLE', 'IMPLANTE'] });
    expect(m.criados[0]).toMatchObject({ template_type: 'LABORATORIO', selected_documents: [], status: 'DRAFT' });
    expect(m.criados[0].events.create.description).toBe(LAB_CONTRATO_MSG.eventoCriado);
  });

  it('clínica (com laboratório cadastrado em outra conta): cria como sempre, pela especialidade e com os termos marcados', async () => {
    const m = banco(CLINICA);
    await m.svc.createForQuote('orc-1', CLINICA, 'usuario-1', { selected_documents: ['USO_IMAGEM'] });
    expect(m.criados[0]).toMatchObject({ template_type: 'IMPLANTE', selected_documents: ['USO_IMAGEM'] });
    expect(m.criados[0].events.create.description).toBe('Documento gerado: IMPLANTE + 1 extras (USO_IMAGEM)');
  });

  it('linha do tempo: laboratório fala do cliente e do laboratório; clínica mantém o texto de sempre', async () => {
    const lab = banco(LAB);
    await lab.svc.markPatientSigned('contrato-1', LAB, 'u');
    await lab.svc.markClinicSigned('contrato-1', LAB, 'u');
    expect(lab.atualizados.map((d) => d.events.create.description)).toEqual([
      LAB_CONTRATO_MSG.eventoClienteAssinou,
      LAB_CONTRATO_MSG.eventoLaboratorioAssinou,
    ]);
    const clinica = banco(CLINICA);
    await clinica.svc.markPatientSigned('contrato-1', CLINICA, 'u');
    await clinica.svc.markClinicSigned('contrato-1', CLINICA, 'u');
    expect(clinica.atualizados.map((d) => d.events.create.description)).toEqual([
      'Paciente assinou (manual)',
      'Clinica assinou — contrato finalizado',
    ]);
  });

  it('ClickSign: laboratório não sobe o contrato na conta da plataforma', async () => {
    const m = banco(LAB);
    const clicksign: any = { sendDocumentForSignature: jest.fn() };
    const svc = new ContractsService(m.prisma, m.pdf, clicksign);
    const e = await svc.sendToClickSign('contrato-1', LAB, 'u').catch((x) => x);
    expect(e.getResponse().code).toBe('VERTICAL_DENIED');
    expect(clicksign.sendDocumentForSignature).not.toHaveBeenCalled();
    expect(m.atualizados).toEqual([]);
  });
});
