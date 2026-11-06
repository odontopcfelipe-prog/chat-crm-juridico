/**
 * Laboratório — contrato de prestação de serviços de prótese dentária.
 *
 * Mesmo fluxo do contrato da clínica (ContractPdfService: checklist de dados que
 * faltam, prévia, PDF do contrato criado), com um texto próprio do laboratório. O
 * contrato da clínica usa um PDF fixo com mapa de coordenadas (overlay-map.json);
 * o do laboratório é desenhado inteiro pelo pdfkit, com as cláusulas de
 * lab-contrato-textos.ts, e por isso não depende de PDF fixo nem de mapa.
 *
 * Os dados vêm só da conta do token:
 *   - CONTRATADA: Tenant (razão social, CNPJ, endereço) e TenantBusinessProfile
 *     (inscrição do laboratório no CRO, responsável técnico e CRO dele);
 *   - CONTRATANTE: o cliente do orçamento (Patient) e a ficha PatientLabProfile
 *     (dentista ou clínica, CRO, razão social, contato);
 *   - serviços: itens do orçamento, com prazo e garantia de ProcedureLabSpec.
 *
 * Funções sem provider Nest (sem DI): ContractPdfService chama daqui só para conta
 * de laboratório. O que vai para o papel vem de LAB_CONTRATO_PDF.
 */
import { Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { formatCpfCnpj } from '@crm/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { logoDaConta } from './quote-pdf-laboratorio';
import {
  LAB_CONTRATO_COMPLETUDE,
  LAB_CONTRATO_PDF,
  type ClausulaDoContrato,
} from './lab-contrato-textos';

/** Só para ler no contrato: (82) 99999-0000. Número fora do padrão sai como está. */
function telefoneParaLeitura(v: string): string {
  const d = v.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return v;
}

/** Só para ler no contrato: 57000-000. CEP fora do padrão sai como está. */
function cepParaLeitura(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : v;
}

const logger = new Logger('ContratoLaboratorio');

export type ContratadaLab = {
  nome: string;
  cnpj: string;
  endereco: string;
  cidade: string;
  uf: string;
  telefone: string;
  email: string;
  logoUrl: string;
  inscricaoCro: string;
  responsavelNome: string;
  responsavelCro: string;
};

export type ClienteLab = {
  nome: string;
  tipo: 'DENTISTA' | 'CLINICA' | null;
  documento: string;
  cro: string;
  representante: string;
  endereco: string;
  cidade: string;
  telefone: string;
  email: string;
};

export type PartesDoContratoLab = { contratada: ContratadaLab; cliente: ClienteLab };

export type ItemCompletude = {
  key: string;
  label: string;
  group: 'patient' | 'clinic' | 'dentist' | 'quote';
  ok: boolean;
  required: boolean;
};

export type CompletudeLab = {
  complete: boolean;
  items: ItemCompletude[];
  missing: string[];
  dentist: { name: string; cro: string };
};

type UsuarioComCro = { name?: string | null; cro_number?: string | null; cro_uf?: string | null } | null | undefined;

const cs = (s: unknown): string => (s !== null && s !== undefined && String(s).trim() ? String(s).trim() : '');

function formatBRL(v: unknown): string {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** "12345" + "AL" → "CRO-AL 12345"; sem UF, o número como está. */
function croCompleto(numero: unknown, uf: unknown): string {
  const n = cs(numero);
  if (!n) return '';
  const u = cs(uf).toUpperCase();
  return u && !/[A-Za-z]{2}/.test(n) ? `CRO-${u} ${n}` : n;
}

/**
 * Lê as partes do contrato. `patient` é o cliente do orçamento (a conta dele já foi
 * conferida por quem chama); a ficha do cliente é lida com a conta do token.
 * `escolhido` é o usuário escolhido para assinar pelo laboratório (opcional).
 */
export async function carregarPartesDoLaboratorio(
  prisma: PrismaService,
  tenantId: string,
  patient: Record<string, any>,
  escolhido?: UsuarioComCro,
): Promise<PartesDoContratoLab> {
  const [tenant, perfil, ficha] = await Promise.all([
    prisma.tenant
      .findUnique({
        where: { id: tenantId },
        select: {
          name: true, cpf_cnpj: true, phone: true, email: true, logo_url: true,
          address: true, address_number: true, address_complement: true, neighborhood: true,
          city: true, state: true, zip_code: true, responsible_name: true, responsible_cro: true,
        },
      })
      .catch(() => null),
    prisma.tenantBusinessProfile
      .findUnique({ where: { tenant_id: tenantId }, select: { lab_cro_inscricao: true, rt_name: true, rt_cro: true } })
      .catch(() => null),
    patient?.id
      ? prisma.patientLabProfile
          .findFirst({
            where: { patient_id: patient.id, tenant_id: tenantId },
            select: { kind: true, cro_number: true, cro_uf: true, legal_name: true, clinic_name: true, contact_name: true },
          })
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const cidade = cs(tenant?.city);
  const uf = cs(tenant?.state);
  const rua = [
    cs(tenant?.address),
    cs(tenant?.address_number) ? `nº ${cs(tenant?.address_number)}` : '',
    cs(tenant?.address_complement),
    cs(tenant?.neighborhood),
  ].filter(Boolean).join(', ');
  const endereco = [rua, cidade ? (uf ? `${cidade}/${uf}` : cidade) : '', cs(tenant?.zip_code) ? `CEP ${cepParaLeitura(cs(tenant?.zip_code))}` : '']
    .filter(Boolean)
    .join(', ');

  // Quem assina pelo laboratório: o usuário escolhido (com CRO), senão o responsável
  // técnico do perfil do laboratório, senão o cadastrado na Identidade.
  const daEscolha = escolhido && cs(escolhido.cro_number)
    ? { nome: cs(escolhido.name), cro: croCompleto(escolhido.cro_number, escolhido.cro_uf) }
    : null;
  const responsavelNome = daEscolha?.nome || cs(perfil?.rt_name) || cs(tenant?.responsible_name);
  const responsavelCro = daEscolha?.cro || cs(perfil?.rt_cro) || cs(tenant?.responsible_cro);

  const contratada: ContratadaLab = {
    nome: cs(tenant?.name) || LAB_CONTRATO_PDF.nomePadraoDaConta,
    cnpj: cs(tenant?.cpf_cnpj),
    endereco,
    cidade,
    uf,
    telefone: cs(tenant?.phone),
    email: cs(tenant?.email),
    logoUrl: cs(tenant?.logo_url),
    inscricaoCro: cs(perfil?.lab_cro_inscricao),
    responsavelNome,
    responsavelCro,
  };

  const kind = ficha?.kind === 'DENTISTA' || ficha?.kind === 'CLINICA' ? (ficha.kind as 'DENTISTA' | 'CLINICA') : null;
  const enderecoCliente = [
    cs(patient?.address) ? `${cs(patient.address)}${cs(patient.address_number) ? `, ${cs(patient.address_number)}` : ''}` : '',
    cs(patient?.neighborhood),
    cs(patient?.city) ? (cs(patient?.state) ? `${cs(patient.city)}/${cs(patient.state)}` : cs(patient.city)) : '',
    cs(patient?.zip_code) ? `CEP ${cepParaLeitura(cs(patient.zip_code))}` : '',
  ].filter(Boolean).join(' — ');

  const cliente: ClienteLab = {
    nome: kind === 'CLINICA' && cs(ficha?.legal_name) ? cs(ficha?.legal_name) : cs(patient?.name),
    tipo: kind,
    documento: formatCpfCnpj(cs(patient?.cpf) || null),
    cro: croCompleto(ficha?.cro_number, ficha?.cro_uf),
    representante: kind === 'CLINICA' ? cs(ficha?.contact_name) : '',
    endereco: enderecoCliente,
    cidade: cs(patient?.city),
    telefone: cs(patient?.phone),
    email: cs(patient?.email),
  };

  return { contratada, cliente };
}

/**
 * Checklist de dados que faltam. Mesmo formato do checklist da clínica; os grupos
 * seguem os da tela: patient = cliente, clinic = laboratório, dentist = responsável
 * técnico que assina, quote = valor.
 */
export function avaliarCompletudeDoLaboratorio(partes: PartesDoContratoLab, total: number): CompletudeLab {
  const { contratada: lab, cliente } = partes;
  const T = LAB_CONTRATO_COMPLETUDE;
  const item = (key: string, label: string, group: ItemCompletude['group'], ok: boolean, required: boolean): ItemCompletude => ({
    key, label, group, ok, required,
  });
  const items: ItemCompletude[] = [
    item('patient_name', T.clienteNome, 'patient', !!cliente.nome, true),
    item('patient_cpf', T.clienteDocumento, 'patient', !!cliente.documento, true),
    item('patient_address', T.clienteEndereco, 'patient', !!cliente.endereco, true),
    item('patient_city', T.clienteCidade, 'patient', !!cliente.cidade, true),
    item('patient_cro', T.clienteCro, 'patient', !!cliente.cro, cliente.tipo === 'DENTISTA'),
    item('patient_phone', T.clienteTelefone, 'patient', !!cliente.telefone, false),
    item('clinic_name', T.labNome, 'clinic', !!lab.nome, true),
    item('clinic_cnpj', T.labCnpj, 'clinic', !!lab.cnpj, true),
    item('clinic_address', T.labEndereco, 'clinic', !!lab.endereco, true),
    item('clinic_city', T.labCidade, 'clinic', !!lab.cidade, true),
    item('clinic_cro_inscricao', T.labInscricaoCro, 'clinic', !!lab.inscricaoCro, false),
    item('dentist_name', T.responsavelNome, 'dentist', !!lab.responsavelNome, true),
    item('dentist_cro', T.responsavelCro, 'dentist', !!lab.responsavelCro, true),
    item('quote_value', T.valor, 'quote', total > 0, true),
  ];
  const missing = items.filter((i) => i.required && !i.ok).map((i) => i.label);
  return {
    complete: missing.length === 0,
    items,
    missing,
    dentist: { name: lab.responsavelNome, cro: lab.responsavelCro },
  };
}

/** Prazo e garantia (em dias) de cada serviço do orçamento, da ficha do serviço da conta. */
export async function lerPrazosDosServicos(
  prisma: PrismaService,
  tenantId: string,
  itens: Array<{ procedure_id?: string | null }>,
): Promise<Map<string, { prazo: number | null; garantia: number | null }>> {
  const ids = Array.from(new Set(itens.map((i) => i.procedure_id).filter((x): x is string => !!x)));
  const mapa = new Map<string, { prazo: number | null; garantia: number | null }>();
  if (!ids.length) return mapa;
  try {
    const fichas = await prisma.procedureLabSpec.findMany({
      where: { tenant_id: tenantId, procedure_id: { in: ids } },
      select: { procedure_id: true, lead_time_days: true, warranty_days: true },
    });
    for (const f of fichas) mapa.set(f.procedure_id, { prazo: f.lead_time_days ?? null, garantia: f.warranty_days ?? null });
  } catch (e) {
    logger.warn(`[LAB-CONTRATO] prazos dos serviços não lidos, o anexo sai sem eles: ${(e as Error)?.message ?? e}`);
  }
  return mapa;
}

export type OpcoesDoPdfLab = {
  /** Valor total por extenso (quem chama usa o mesmo extenso do contrato da clínica). */
  valorExtenso: string;
  prazos: Map<string, { prazo: number | null; garantia: number | null }>;
  /** Marca no rodapé: prévia, cancelado, expirado ou modelo de exemplo. */
  marca: string;
  /** Data do documento (dia da geração). */
  hoje?: Date;
};

/** Desenha o PDF do contrato do laboratório. `contract.quote` traz o cliente e os itens. */
export function desenharContratoDoLaboratorio(
  contract: any,
  partes: PartesDoContratoLab,
  opts: OpcoesDoPdfLab,
): Promise<Buffer> {
  const L = LAB_CONTRATO_PDF;
  const { contratada: lab, cliente } = partes;
  const quote = contract.quote;
  const numero = quote.quote_number ? String(quote.quote_number) : String(quote.id || '').slice(0, 8).toUpperCase();
  const total = Number(quote.total_value) || 0;
  const valorBR = total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const foro = lab.cidade ? (lab.uf ? `${lab.cidade}/${lab.uf}` : lab.cidade) : '______________';
  const clausulas: ClausulaDoContrato[] = L.clausulas({
    numeroOrcamento: numero,
    valor: valorBR,
    valorExtenso: opts.valorExtenso,
    pagamento: cs(quote.payment_terms) || null,
    foro,
  });
  const logo = logoDaConta(lab.logoUrl || null);
  const hoje = opts.hoje ?? new Date();

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: L.tituloDoc(numero, cliente.nome), Author: lab.nome, Subject: L.assunto },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ── Cabeçalho da conta
    if (logo) {
      try {
        const topo = doc.y;
        doc.image(logo, left + (W - 120) / 2, topo, { fit: [120, 50], align: 'center', valign: 'center' });
        doc.y = topo + 56;
        doc.x = left;
      } catch (e) {
        logger.warn(`[LAB-CONTRATO] logo da conta não desenhada, o PDF segue sem ela: ${(e as Error)?.message ?? e}`);
      }
    }
    doc.font('Helvetica-Bold').fontSize(16).text(lab.nome, left, doc.y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(9).text(L.subtitulo, { width: W, align: 'center' });
    if (lab.cnpj) doc.text(L.cnpjDaConta(formatCpfCnpj(lab.cnpj)), { width: W, align: 'center' });
    if (lab.endereco) doc.text(lab.endereco, { width: W, align: 'center' });
    const contato = [telefoneParaLeitura(lab.telefone), lab.email].filter(Boolean).join(' · ');
    if (contato) doc.text(contato, { width: W, align: 'center' });

    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(13).text(L.titulo, { align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#666').text(L.referenciaOrcamento(numero), { align: 'center' });
    doc.fillColor('black');
    doc.moveDown(1);

    // ── Partes
    doc.font('Helvetica-Bold').fontSize(10.5).text(L.tituloPartes);
    doc.moveDown(0.4);
    doc.fontSize(10);
    const tipoTexto = cliente.tipo === 'DENTISTA' ? L.clienteDentista : cliente.tipo === 'CLINICA' ? L.clienteClinica : '';
    const dadosCliente = [
      tipoTexto,
      cliente.documento ? L.documentoDoCliente(cliente.documento) : '',
      cliente.cro ? L.croDoCliente(cliente.cro) : '',
      cliente.endereco ? `${cliente.endereco}` : '',
      cliente.representante ? L.representadaPor(cliente.representante) : '',
      cliente.telefone ? L.telefone(telefoneParaLeitura(cliente.telefone)) : '',
      cliente.email ? L.email(cliente.email) : '',
    ].filter(Boolean).join(', ');
    doc.font('Helvetica-Bold').text(L.contratante, { continued: true })
      .font('Helvetica').text(`${cliente.nome || L.semNome}${dadosCliente ? `, ${dadosCliente}` : ''}.`, { align: 'justify' });

    doc.moveDown(0.5);
    const qualificacao = [
      lab.cnpj ? L.qualificacaoCnpj(formatCpfCnpj(lab.cnpj)) : '',
      lab.endereco ? L.qualificacaoSede(lab.endereco) : '',
      lab.inscricaoCro ? L.qualificacaoInscricaoCro(lab.inscricaoCro) : '',
      lab.responsavelNome ? L.qualificacaoResponsavel(lab.responsavelNome, lab.responsavelCro) : '',
    ].filter(Boolean).join(', ');
    doc.font('Helvetica-Bold').text(L.contratada, { continued: true })
      .font('Helvetica').text(`${lab.nome}${qualificacao ? `, ${qualificacao}` : ''}.`, { align: 'justify' });
    doc.moveDown(0.8);

    // ── Cláusulas
    for (const c of clausulas) {
      if (doc.y > doc.page.maxY() - 70) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10.5).text(c.titulo);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9.5);
      for (const p of c.paragrafos) {
        doc.text(p, { align: 'justify' });
        doc.moveDown(0.3);
      }
      doc.moveDown(0.3);
    }

    // ── Local, data e assinaturas (juntos: se não couberem, vão inteiros para a página seguinte)
    const dataExtenso = hoje.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    const local = lab.cidade ? (lab.uf ? `${lab.cidade}/${lab.uf}` : lab.cidade) : '';
    const SIG_W = 230;
    const pSub = cliente.documento ? L.documentoDoCliente(cliente.documento) : L.assinaturaCliente;
    const cSub = lab.responsavelNome ? L.responsavelTecnico(lab.responsavelNome, lab.responsavelCro) : L.assinaturaLaboratorio;
    doc.fontSize(9).font('Helvetica-Bold');
    const pNomeH = doc.heightOfString(cliente.nome || L.semNome, { width: SIG_W });
    const cNomeH = doc.heightOfString(lab.nome, { width: SIG_W });
    doc.font('Helvetica');
    const alturaColuna = 15 + Math.max(
      pNomeH + 2 + doc.heightOfString(pSub, { width: SIG_W }),
      cNomeH + 2 + doc.heightOfString(cSub, { width: SIG_W }),
    );
    doc.fontSize(10);
    const alturaData = doc.currentLineHeight(true) * 3;
    if (doc.y + alturaData + alturaColuna + 6 > doc.page.maxY()) doc.addPage();
    doc.text(local ? L.localEData(local, dataExtenso) : dataExtenso, left, doc.y, { align: 'right', width: W });
    doc.moveDown(2);
    const yPos = doc.y;
    doc.fontSize(9);
    doc.font('Helvetica').fillColor('black').text('_______________________________________', 60, yPos);
    doc.font('Helvetica-Bold').text(cliente.nome || L.semNome, 60, yPos + 15, { width: SIG_W });
    doc.font('Helvetica').fillColor('#555').text(pSub, 60, yPos + 15 + pNomeH + 2, { width: SIG_W });
    doc.font('Helvetica').fillColor('black').text('_______________________________________', 320, yPos);
    doc.font('Helvetica-Bold').text(lab.nome, 320, yPos + 15, { width: SIG_W });
    doc.font('Helvetica').fillColor('#555').text(cSub, 320, yPos + 15 + cNomeH + 2, { width: SIG_W });
    doc.fillColor('black').fontSize(10);

    // ── Anexo I: serviços, prazo, garantia e valor
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12).text(L.anexoTitulo, left, doc.y, { width: W });
    doc.font('Helvetica').fontSize(9).fillColor('#666').text(L.referenciaOrcamento(numero));
    doc.fillColor('black');
    doc.moveDown(0.8);
    const col = { serv: W * 0.36, elem: W * 0.1, qtd: W * 0.07, prazo: W * 0.15, gar: W * 0.16, total: W * 0.16 };
    const cabecalho = () => {
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5);
      doc.text(L.colServico, left, y, { width: col.serv });
      doc.text(L.colElemento, left + col.serv, y, { width: col.elem, align: 'center' });
      doc.text(L.colQtd, left + col.serv + col.elem, y, { width: col.qtd, align: 'right' });
      doc.text(L.colPrazo, left + col.serv + col.elem + col.qtd, y, { width: col.prazo, align: 'right' });
      doc.text(L.colGarantia, left + col.serv + col.elem + col.qtd + col.prazo, y, { width: col.gar, align: 'right' });
      doc.text(L.colTotal, left + col.serv + col.elem + col.qtd + col.prazo + col.gar, y, { width: col.total, align: 'right' });
      doc.moveDown(0.4);
      doc.moveTo(left, doc.y).lineTo(left + W, doc.y).stroke();
      doc.moveDown(0.3);
    };
    cabecalho();
    doc.font('Helvetica').fontSize(9);
    for (const it of quote.items || []) {
      if (doc.y > doc.page.maxY() - 60) {
        doc.addPage();
        cabecalho();
        doc.font('Helvetica').fontSize(9);
      }
      const y = doc.y;
      const ficha = it.procedure_id ? opts.prazos.get(it.procedure_id) : undefined;
      doc.text(it.procedure?.name || L.servicoSemNome, left, y, { width: col.serv });
      const alturaLinha = doc.y;
      doc.text(it.tooth_fdi || L.semElemento, left + col.serv, y, { width: col.elem, align: 'center' });
      doc.text(String(it.quantity ?? 1), left + col.serv + col.elem, y, { width: col.qtd, align: 'right' });
      doc.text(ficha?.prazo != null ? String(ficha.prazo) : L.semPrazo, left + col.serv + col.elem + col.qtd, y, { width: col.prazo, align: 'right' });
      doc.text(ficha?.garantia != null ? String(ficha.garantia) : L.semGarantia, left + col.serv + col.elem + col.qtd + col.prazo, y, { width: col.gar, align: 'right' });
      doc.text(formatBRL(it.total_price), left + col.serv + col.elem + col.qtd + col.prazo + col.gar, y, { width: col.total, align: 'right' });
      doc.y = Math.max(doc.y, alturaLinha);
      if (it.notes) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666').text(L.obs(String(it.notes)), left + 10, doc.y, { width: W - 10 });
        doc.fillColor('black').font('Helvetica').fontSize(9);
      }
      doc.moveDown(0.4);
    }
    doc.moveTo(left, doc.y).lineTo(left + W, doc.y).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).text(`${L.totalDoAnexo} ${formatBRL(total)}`, left, doc.y, { width: W, align: 'right' });
    if (cs(quote.payment_terms)) {
      doc.moveDown(0.6);
      doc.font('Helvetica').fontSize(9.5).text(L.pagamentoDoAnexo(cs(quote.payment_terms)), left, doc.y, { width: W });
    }

    // ── Rodapé da última página, escrito dentro da margem inferior (sem abrir página nova)
    const margemInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor('#999').text(
      L.rodape(String(contract.id || '').substring(0, 8), new Date().toLocaleString('pt-BR'), opts.marca),
      50, doc.page.height - 35, { align: 'center', width: doc.page.width - 100, lineBreak: false },
    );
    doc.page.margins.bottom = margemInferior;

    doc.end();
  });
}

/** Marca do rodapé: prévia (antes de criar), cancelado, expirado ou modelo de exemplo. */
export function marcaDoContrato(contract: { id?: string; status?: string }, modelo = false): string {
  const L = LAB_CONTRATO_PDF;
  if (modelo) return L.marcaModelo;
  if (contract.id === 'preview') return L.marcaPrevia;
  if (contract.status === 'CANCELLED') return L.marcaCancelado;
  if (contract.status === 'EXPIRED') return L.marcaExpirado;
  return '';
}

/**
 * Contrato de EXEMPLO do laboratório: os dados reais da conta (CONTRATADA) com o
 * cliente e o serviço em branco. É o que a tela de configuração mostra para o
 * laboratório e o advogado dele revisarem o texto. Nada é gravado.
 */
export async function desenharModeloDoLaboratorio(
  prisma: PrismaService,
  tenantId: string,
  valorExtenso: (v: number) => string,
): Promise<Buffer> {
  const M = LAB_CONTRATO_PDF.modelo;
  const base = await carregarPartesDoLaboratorio(prisma, tenantId, {}, null);
  const partes: PartesDoContratoLab = {
    contratada: base.contratada,
    cliente: {
      nome: M.cliente,
      tipo: 'DENTISTA',
      documento: M.documento,
      cro: '',
      representante: '',
      endereco: '',
      cidade: '',
      telefone: '',
      email: '',
    },
  };
  const contract = {
    id: 'modelo',
    status: 'DRAFT',
    quote: {
      id: 'modelo',
      quote_number: null,
      total_value: 1000,
      payment_terms: null,
      items: [{ procedure: { name: M.servico }, tooth_fdi: null, quantity: 1, total_price: 1000, notes: null }],
    },
  };
  return desenharContratoDoLaboratorio(contract, partes, {
    valorExtenso: valorExtenso(1000),
    prazos: new Map(),
    marca: marcaDoContrato(contract, true),
  });
}
