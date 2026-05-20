/**
 * ContractPdfService — Onda 14.24 Fase 1.5.
 *
 * Gera PDF do contrato + TCLE pra um Contract DRAFT/SENT/etc, antes de
 * subir pro ClickSign na Fase 2. Permite:
 *  - Operador conferir o conteudo antes de enviar
 *  - Mostrar pro paciente em consulta presencial
 *  - Preparar caminho pra Fase 2 (ClickSign vai consumir o mesmo PDF)
 *
 * Templates por especialidade (4 tipos):
 *   ORTODONTIA      — aparelho + manutencao mensal + prazo de tratamento
 *   IMPLANTE        — implante + protese + etapas cirurgicas + cuidados
 *   LENTES          — lentes/facetas + garantia + manutencao
 *   CLINICO_BASICO  — procedimentos diversos (fallback)
 *
 * Conteudo comum: qualificacao partes, objeto, valor/pagamento, LGPD,
 * local/data, linhas pra assinatura.
 */
import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Onda 14.32 — Mapeamento docId → nome do PDF anexo em contract-templates/.
 * Se o arquivo existir, e mesclado ao final do contrato principal. Se nao
 * existir, fallback no texto base via pdfkit (extraDocumentContent).
 */
const EXTRA_DOCUMENT_PDF_MAP: Record<string, string> = {
  USO_IMAGEM: 'uso-de-imagem.pdf',
  CLAREAMENTO: 'clareamento.pdf',
  FACETAS_RESINA: 'facetas-de-resina.pdf',
  LAMINADOS_CERAMICOS: 'laminados-ceramicos.pdf',
  PROTESE: 'protese-pronto.pdf',
  ENDODONTIA_ADULTO: 'termo-endo.pdf',
  ENDODONTIA_MENOR: 'termo-endo-menor.pdf',
  EXTRACAO_ADULTO: 'termo-extracao-adulto.pdf',
  EXTRACAO_MENOR: 'termo-exo-menor-certo.pdf',
  IMPLANTE: 'termo-implante.pdf',
  RESTAURACAO: 'termo-pronto-restauracao.pdf',
};

@Injectable()
export class ContractPdfService {
  private readonly logger = new Logger(ContractPdfService.name);
  /** Onda 14.32 — Caminho dos PDFs anexos. Resolvido via __dirname pra
   *  funcionar tanto em dev (src/) quanto em producao (dist/). */
  private readonly templatesDir = path.join(__dirname, 'contract-templates');

  constructor(private prisma: PrismaService) {}

  /**
   * Gera o PDF do contrato. Inclui dados do paciente, items do quote,
   * valor total, forma de pagamento e clausulas especificas da especialidade.
   * Retorna buffer pra ser entregue como application/pdf.
   */
  async generatePdf(contractId: string, tenantId: string): Promise<Buffer> {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: {
        quote: {
          include: {
            patient: {
              select: {
                id: true, name: true, cpf: true, rg: true, birth_date: true,
                phone: true, email: true, tenant_id: true,
                address: true, address_number: true, neighborhood: true,
                city: true, state: true, zip_code: true,
              },
            },
            items: {
              orderBy: { order_index: 'asc' },
              include: {
                procedure: { select: { name: true, code_tuss: true } },
              },
            },
            created_by: { select: { name: true } },
          },
        },
      },
    });

    if (!contract) throw new NotFoundException('Contrato nao encontrado');
    if (contract.quote.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Contrato de outro tenant');
    }

    // Tenant pra cabecalho. Por enquanto so o nome — campos estruturados
    // (CNPJ, endereco, telefone, email) vao ficar pra Fase 3 quando
    // implementarmos config de clinica no admin com campos proprios. Por
    // ora extraimos do OrganizationProfile.facts (JSON livre) com fallback.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        organization_profile: { select: { facts: true } },
      },
    });

    const facts = (tenant?.organization_profile?.facts as Record<string, unknown> | null) || {};
    const officeInfo = (facts.office_info as Record<string, unknown> | undefined) || {};
    const tenantInfo = {
      name: tenant?.name || null,
      cnpj: (officeInfo.cnpj as string | undefined) || (officeInfo.tax_id as string | undefined) || null,
      address: (officeInfo.address as string | undefined) || null,
      phone: (officeInfo.phone as string | undefined) || null,
      email: (officeInfo.email as string | undefined) || null,
    };

    // Onda 14.32 — Identifica quais docs extras tem PDF anexo. Esses sao
    // mesclados ao final via pdf-lib. Docs SEM PDF anexo continuam sendo
    // renderizados como secoes textuais via pdfkit dentro do renderPdf.
    const selectedDocs = Array.isArray(contract.selected_documents)
      ? (contract.selected_documents as string[])
      : [];
    const docsWithAttachment: string[] = [];
    const docsWithoutAttachment: string[] = [];
    for (const docId of selectedDocs) {
      if (['TCLE', 'LGPD', 'CONTRATO_PRINCIPAL'].includes(docId)) continue;
      const pdfPath = await this.resolveExtraDocPath(docId);
      if (pdfPath) docsWithAttachment.push(docId);
      else docsWithoutAttachment.push(docId);
    }

    // 1. Renderiza o contrato principal via pdfkit (com secoes textuais dos
    //    docs que NAO tem PDF anexo).
    const mainPdfBuffer = await this.renderPdf(contract, tenantInfo, docsWithoutAttachment);

    // 2. Se nao ha PDFs anexos, retorna direto o buffer do principal.
    if (docsWithAttachment.length === 0) {
      return mainPdfBuffer;
    }

    // 3. Mescla via pdf-lib: principal + cada PDF anexo na ordem dos
    //    selected_documents.
    return this.mergeWithAttachments(mainPdfBuffer, docsWithAttachment);
  }

  /**
   * Onda 14.32 — Resolve caminho do PDF anexo pro docId. Retorna null se
   * arquivo nao existir. Verifica acesso via fs.access pra distinguir "nao
   * configurado" de "erro de permissao".
   */
  private async resolveExtraDocPath(docId: string): Promise<string | null> {
    const filename = EXTRA_DOCUMENT_PDF_MAP[docId];
    if (!filename) return null;
    const fullPath = path.join(this.templatesDir, filename);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      return null;
    }
  }

  /**
   * Onda 14.32 — Mescla o contrato principal (buffer pdfkit) com os PDFs
   * anexos correspondentes aos docIds passados. Usa pdf-lib pra copiar
   * paginas. Mantem ordem do array docIds.
   */
  private async mergeWithAttachments(
    mainPdfBuffer: Buffer,
    docIds: string[],
  ): Promise<Buffer> {
    try {
      const merged = await PDFLibDocument.load(mainPdfBuffer);
      for (const docId of docIds) {
        const pdfPath = await this.resolveExtraDocPath(docId);
        if (!pdfPath) continue;
        try {
          const pdfBytes = await fs.readFile(pdfPath);
          const attachedDoc = await PDFLibDocument.load(pdfBytes);
          const copiedPages = await merged.copyPages(
            attachedDoc,
            attachedDoc.getPageIndices(),
          );
          for (const page of copiedPages) {
            merged.addPage(page);
          }
          this.logger.log(`[Contract PDF] Mesclado ${docId} (${pdfPath})`);
        } catch (e: unknown) {
          // Se falhar a mesclagem de um anexo especifico, loga e segue.
          // Operador pode tentar pre-visualizar de novo apos corrigir o
          // arquivo. Comportamento defensivo.
          const err = e as Error;
          this.logger.warn(
            `[Contract PDF] Falha ao mesclar ${docId}: ${err.message}. Pulando.`,
          );
        }
      }
      const finalBytes = await merged.save();
      return Buffer.from(finalBytes);
    } catch (e: unknown) {
      // Se algo catastrofico falhar na mesclagem (ex: pdf-lib quebrou),
      // retorna so o principal pra nao quebrar o fluxo.
      const err = e as Error;
      this.logger.error(`[Contract PDF] Erro fatal na mesclagem: ${err.message}`);
      return mainPdfBuffer;
    }
  }

  private renderPdf(
    contract: any,
    tenant: { name: string | null; cnpj: string | null; address: string | null; phone: string | null; email: string | null },
    /** Onda 14.32 — IDs dos docs extras que devem ser renderizados como
     *  secoes textuais (porque NAO tem PDF anexo). Docs com PDF anexo
     *  NAO entram aqui — sao mesclados depois via pdf-lib. */
    textualExtraDocs: string[] = [],
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50, info: {
        Title: `Contrato — Quote #${contract.quote.quote_number || ''}`,
        Author: tenant?.name || 'Clínica',
        Subject: 'Contrato de prestacao de servicos odontologicos',
      } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const quote = contract.quote;
      const patient = quote.patient;

      // ── Header ────────────────────────────────────────────────
      doc
        .fontSize(16).font('Helvetica-Bold')
        .text(tenant?.name || 'Clínica Odontológica', { align: 'center' });
      if (tenant?.cnpj) {
        doc.fontSize(9).font('Helvetica').text(`CNPJ: ${tenant.cnpj}`, { align: 'center' });
      }
      if (tenant?.address) {
        doc.fontSize(9).text(tenant.address, { align: 'center' });
      }
      if (tenant?.phone || tenant?.email) {
        const contact = [tenant?.phone, tenant?.email].filter(Boolean).join(' · ');
        doc.fontSize(9).text(contact, { align: 'center' });
      }

      doc.moveDown(1);
      doc
        .fontSize(13).font('Helvetica-Bold')
        .text('CONTRATO DE PRESTAÇÃO DE SERVIÇOS ODONTOLÓGICOS', { align: 'center' });
      doc
        .fontSize(10).font('Helvetica').fillColor('#666')
        .text(`Template: ${this.templateTitle(contract.template_type)}`, { align: 'center' });
      doc.fillColor('black');
      doc.moveDown(1);

      // ── Qualificacao das partes ──────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').text('1. Qualificação das partes');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica');

      doc.font('Helvetica-Bold').text('CONTRATANTE: ', { continued: true })
        .font('Helvetica').text(patient.name || '—');
      const patientDetails = [
        patient.cpf ? `CPF: ${patient.cpf}` : null,
        patient.rg ? `RG: ${patient.rg}` : null,
        patient.phone ? `Telefone: ${patient.phone}` : null,
        patient.email ? `Email: ${patient.email}` : null,
      ].filter(Boolean).join(' · ');
      if (patientDetails) doc.text(patientDetails);
      const addressParts = [
        patient.address ? `${patient.address}, ${patient.address_number || 's/n'}` : null,
        patient.neighborhood,
        patient.city && patient.state ? `${patient.city}/${patient.state}` : null,
        patient.zip_code ? `CEP ${patient.zip_code}` : null,
      ].filter(Boolean).join(' · ');
      if (addressParts) doc.text(addressParts);

      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('CONTRATADA: ', { continued: true })
        .font('Helvetica').text(tenant?.name || 'Clínica');

      doc.moveDown(0.8);

      // ── Objeto ───────────────────────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').text('2. Objeto');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica');
      doc.text(
        `O presente contrato tem por objeto a prestação dos serviços odontológicos abaixo discriminados, ` +
        `referentes ao orçamento ${quote.quote_number ? `#${String(quote.quote_number).padStart(3, '0')}` : quote.id}` +
        (quote.title ? ` — ${quote.title}` : '') +
        `. Os procedimentos serão executados pela CONTRATADA segundo as melhores práticas odontológicas, ` +
        `respeitando as normas do CFO/CRO.`,
        { align: 'justify' },
      );

      doc.moveDown(0.6);

      // Tabela simplificada de items
      doc.fontSize(10).font('Helvetica-Bold').text('Procedimentos contratados:');
      doc.moveDown(0.2);
      doc.fontSize(9).font('Helvetica');
      for (const item of quote.items) {
        const tooth = item.tooth_fdi ? ` · dente ${item.tooth_fdi}` : '';
        const qty = item.quantity > 1 ? ` (${item.quantity}×)` : '';
        const price = `R$ ${Number(item.total_price).toFixed(2).replace('.', ',')}`;
        doc.text(`• ${item.procedure?.name || 'Procedimento'}${tooth}${qty} — ${price}`);
      }

      doc.moveDown(0.6);

      // ── Valor e pagamento ────────────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').text('3. Valor e forma de pagamento');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica');
      const total = Number(quote.total_value);
      doc.text(
        `Valor total: R$ ${total.toFixed(2).replace('.', ',')}.` +
        (quote.payment_terms ? `\nForma de pagamento: ${quote.payment_terms}.` : ''),
      );
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor('#666').text(
        'Em caso de inadimplência, a CONTRATADA poderá suspender a execução dos procedimentos não realizados até a regularização do pagamento.',
        { align: 'justify' },
      );
      doc.fillColor('black');

      doc.moveDown(0.8);

      // ── Cláusulas específicas da especialidade ───────────────
      doc.fontSize(11).font('Helvetica-Bold').text('4. Cláusulas específicas do tratamento');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica');
      for (const clause of this.specialtyClauses(contract.template_type)) {
        doc.text(`• ${clause}`, { align: 'justify' });
        doc.moveDown(0.2);
      }

      doc.moveDown(0.5);

      // ── TCLE ─────────────────────────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').text('5. Termo de Consentimento Livre e Esclarecido (TCLE)');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica');
      doc.text(
        'Declaro que fui devidamente informado(a) sobre o diagnóstico, os procedimentos propostos, ' +
        'as alternativas terapêuticas, os riscos, benefícios e limitações do tratamento, bem como sobre os cuidados ' +
        'pós-operatórios. Tive oportunidade de fazer perguntas e todas foram respondidas a contento. Autorizo ' +
        'a CONTRATADA a executar os procedimentos acima descritos.',
        { align: 'justify' },
      );

      doc.moveDown(0.8);

      // ── LGPD ─────────────────────────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').text('6. Tratamento de dados (LGPD)');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica');
      doc.text(
        'Os dados pessoais e clínicos do CONTRATANTE serão tratados pela CONTRATADA exclusivamente para ' +
        'execução do tratamento, conforme Lei 13.709/2018 (LGPD). O CONTRATANTE poderá solicitar acesso, ' +
        'correção e exclusão de seus dados a qualquer momento.',
        { align: 'justify' },
      );

      // Onda 14.30 — Documentos extras selecionados pelo operador. Cada um
      // vira uma secao numerada apos a LGPD. TCLE/LGPD/CONTRATO_PRINCIPAL
      // sao filtrados pq ja sao incluidos nas secoes base 5/6/objeto.
      // Onda 14.32 — Apenas docs SEM PDF anexo entram aqui (textualExtraDocs).
      // Docs COM PDF anexo sao mesclados depois via pdf-lib no generatePdf.
      let sectionNumber = 7;
      for (const docId of textualExtraDocs) {
        const docContent = this.extraDocumentContent(docId);
        if (!docContent) continue;
        doc.moveDown(0.8);
        doc.fontSize(11).font('Helvetica-Bold').text(`${sectionNumber}. ${docContent.title}`);
        doc.moveDown(0.4);
        doc.fontSize(10).font('Helvetica').text(docContent.body, { align: 'justify' });
        sectionNumber++;
      }

      doc.moveDown(1);

      // ── Assinaturas ──────────────────────────────────────────
      doc.fontSize(10).font('Helvetica');
      const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
      doc.text(`${(tenant?.address?.split(',').pop() || 'Local').trim()}, ${today}`, { align: 'right' });

      doc.moveDown(2);
      const yPos = doc.y;
      doc.text('_______________________________________', 60, yPos);
      doc.text('CONTRATANTE (paciente)', 60, yPos + 15);

      doc.text('_______________________________________', 320, yPos);
      doc.text('CONTRATADA (clínica)', 320, yPos + 15);

      // ── Footer ───────────────────────────────────────────────
      const footerY = doc.page.height - 50;
      doc.fontSize(8).fillColor('#999')
        .text(
          `Contrato ${contract.id.substring(0, 8)} · Gerado em ${new Date().toLocaleString('pt-BR')} · ` +
          (contract.status === 'DRAFT' ? 'PRÉ-VISUALIZAÇÃO (não assinado)' : `Status: ${contract.status}`),
          50, footerY, { align: 'center', width: doc.page.width - 100 },
        );

      doc.end();
    });
  }

  private templateTitle(type: string): string {
    const map: Record<string, string> = {
      ORTODONTIA: 'Ortodontia',
      IMPLANTE: 'Implantes Dentários',
      LENTES: 'Lentes / Facetas',
      CLINICO_BASICO: 'Clínico Básico',
    };
    return map[type] || 'Clínico Básico';
  }

  /** Cláusulas específicas do tratamento por especialidade. Texto sucinto;
   *  Fase 3 vai permitir customizacao por tenant via admin. */
  private specialtyClauses(type: string): string[] {
    if (type === 'ORTODONTIA') {
      return [
        'O tratamento ortodôntico tem duração média estimada entre 18 e 30 meses, podendo variar conforme resposta biológica do paciente.',
        'O CONTRATANTE compromete-se a comparecer às manutenções mensais nas datas agendadas. Faltas e atrasos podem prolongar o tratamento.',
        'O uso correto dos aparelhos e elásticos é responsabilidade do CONTRATANTE. A perda ou quebra de peças implica custo adicional de reposição.',
        'A higiene oral rigorosa é fundamental — descalcificações, cáries e gengivites decorrentes de má higiene não são responsabilidade da CONTRATADA.',
        'Ao final do tratamento ativo, o CONTRATANTE receberá contenções e deverá usá-las conforme orientado para manter o resultado.',
      ];
    }
    if (type === 'IMPLANTE') {
      return [
        'O tratamento envolve etapas cirúrgicas e protéticas. O prazo médio entre o implante e a colocação da prótese definitiva é de 4 a 8 meses, dependendo da osseointegração.',
        'O sucesso do tratamento depende de fatores biológicos individuais (qualidade óssea, cicatrização, saúde sistêmica). Embora a taxa de sucesso seja alta (>95%), há risco de rejeição ou perda do implante.',
        'O CONTRATANTE compromete-se a seguir rigorosamente as orientações pós-operatórias e comparecer às consultas de acompanhamento.',
        'Tabagismo, diabetes descompensado e bruxismo aumentam o risco de complicações. O CONTRATANTE deve informar essas condições à equipe.',
        'A higiene em torno do implante é crítica — peri-implantite por má higiene não é coberta pela garantia do tratamento.',
      ];
    }
    if (type === 'LENTES') {
      return [
        'Lentes e facetas de porcelana são procedimentos estéticos definitivos que envolvem desgaste mínimo do esmalte dental.',
        'A cor e formato finais são aprovados pelo CONTRATANTE em fase de "mock-up" antes da cimentação definitiva. Após cimentação, ajustes maiores não são possíveis sem refazer a peça.',
        'A garantia da CONTRATADA é de 12 meses para fraturas decorrentes de defeito de material ou execução, desde que respeitados os cuidados orientados.',
        'O CONTRATANTE deve evitar morder objetos duros, roer unhas e abrir embalagens com os dentes — tais hábitos podem fraturar as peças e não são cobertos por garantia.',
        'Manutenção semestral é recomendada para profilaxia e verificação das peças.',
      ];
    }
    // CLINICO_BASICO (fallback)
    return [
      'Os procedimentos serão executados conforme a melhor técnica disponível, respeitando as normas do CFO/CRO.',
      'O CONTRATANTE deve comparecer às consultas agendadas e seguir as orientações de cuidado pós-procedimento.',
      'A CONTRATADA garante a qualidade técnica do trabalho executado. Garantias específicas (próteses, restaurações) seguem prazos da legislação aplicável.',
      'Eventuais retornos para ajustes em até 30 dias após o procedimento estão inclusos no valor contratado.',
    ];
  }

  /** Onda 14.30/14.31 — Conteudo dos documentos extras opcionais. Retornados
   *  como secoes adicionais no PDF quando o operador marca o checkbox no card
   *  "Contrato de tratamento" antes de criar o contrato.
   *
   *  Onda 14.31 — Adicionados 10 termos por procedimento da clinica (clareamento,
   *  facetas, lentes, protese, endo, exo, implante, restauracao). Textos
   *  contratuais sao TEMPLATES BASE — devem ser substituidos pelo conteudo
   *  oficial dos PDFs da clinica (clareamento.pdf, termo-implante.pdf, etc).
   *  Pra fazer essa substituicao, o operador/dev edita o texto desta funcao
   *  preservando os mesmos IDs. Fase futura (14.32+): ler de templates
   *  configurados via admin em vez de hardcoded aqui.
   */
  private extraDocumentContent(docId: string): { title: string; body: string } | null {
    const map: Record<string, { title: string; body: string }> = {
      // ── Termos gerais (Onda 14.30) ──
      USO_IMAGEM: {
        title: 'Termo de autorização de uso de imagem',
        body:
          'Autorizo a CONTRATADA a captar e utilizar minha imagem (fotos pré e pós-tratamento, ' +
          'radiografias e modelos) exclusivamente para fins de documentação clínica, divulgação ' +
          'profissional em materiais educativos, redes sociais e portfólio da clínica, sem qualquer ' +
          'ônus financeiro. As imagens não serão utilizadas para fins comerciais sem autorização ' +
          'expressa adicional. Posso revogar esta autorização a qualquer momento por escrito.',
      },
      GARANTIA: {
        title: 'Termo de garantia estendida',
        body:
          'A CONTRATADA oferece garantia ESTENDIDA de 24 (vinte e quatro) meses para os ' +
          'procedimentos executados, contados a partir da conclusão do tratamento. A garantia ' +
          'cobre defeitos de execução técnica e materiais empregados. NÃO estão cobertos por ' +
          'esta garantia: danos por trauma, má higiene, uso inadequado, alterações biológicas ' +
          'individuais e desgaste natural. Manutenções preventivas semestrais são obrigatórias ' +
          'para manter a validade da garantia.',
      },
      RESPONSAVEL_LEGAL: {
        title: 'Responsável legal (paciente menor de idade ou incapaz)',
        body:
          'Considerando que o CONTRATANTE é menor de 18 anos ou legalmente incapaz, este ' +
          'contrato é assinado pelo seu responsável legal, que declara ter plena capacidade ' +
          'civil para celebrar este instrumento em nome do CONTRATANTE, autorizando a ' +
          'execução do tratamento aqui descrito e assumindo a responsabilidade pelo pagamento ' +
          'integral dos valores acordados.\n\n' +
          'Nome do responsável legal: _____________________________________________\n' +
          'CPF: __________________________ · RG: __________________________________\n' +
          'Grau de parentesco: ____________________________________________________',
      },
      AGENDAMENTO: {
        title: 'Cláusula de agendamento e faltas',
        body:
          'O CONTRATANTE compromete-se a comparecer às consultas agendadas no horário marcado. ' +
          'Cancelamentos devem ser comunicados com antecedência mínima de 24 horas. Faltas ' +
          'consecutivas (3 ou mais) sem justificativa podem implicar suspensão temporária do ' +
          'tratamento. Em caso de atraso superior a 20 minutos, a consulta poderá ser ' +
          'remarcada conforme disponibilidade da agenda.',
      },
      RESCISAO: {
        title: 'Cláusula de rescisão antecipada',
        body:
          'Qualquer das partes poderá rescindir este contrato mediante comunicação formal por ' +
          'escrito com antecedência mínima de 15 dias. Em caso de rescisão por iniciativa do ' +
          'CONTRATANTE, serão devidos os valores correspondentes aos procedimentos já ' +
          'executados, conforme tabela vigente, abatendo-se eventuais valores já pagos. Em ' +
          'caso de rescisão por iniciativa da CONTRATADA por inadimplência, aplicam-se as ' +
          'mesmas regras.',
      },

      // ── Onda 14.31 — Termos por procedimento (templates base; substituir
      //    pelo conteudo oficial dos PDFs da clinica) ──

      CLAREAMENTO: {
        title: 'Termo de Clareamento Dental',
        body:
          'Declaro estar ciente de que o clareamento dental é um procedimento estético que pode ' +
          'apresentar resultados variáveis conforme a cor inicial dos dentes, idade e hábitos do ' +
          'CONTRATANTE. Os principais efeitos colaterais possíveis são: sensibilidade dentária ' +
          'temporária, irritação gengival e variação na cor final entre dentes adjacentes. O ' +
          'resultado não é permanente — depende dos hábitos alimentares (café, vinho tinto, ' +
          'tabaco) e da higiene oral. Sessões de manutenção a cada 12-18 meses são recomendadas. ' +
          'Comprometo-me a seguir as orientações pós-clareamento, incluindo dieta clara nas ' +
          '48h seguintes a cada sessão.',
      },
      FACETAS_RESINA: {
        title: 'Termo de Facetas de Resina',
        body:
          'As facetas de resina composta são uma alternativa estética e funcional para correção ' +
          'de cor, forma e pequenos desalinhamentos dentários. Declaro estar ciente de que: (i) ' +
          'a durabilidade média é de 3 a 7 anos, dependendo dos hábitos; (ii) podem sofrer ' +
          'manchamento gradual e necessitar polimento periódico; (iii) fraturas podem ocorrer ' +
          'em casos de bruxismo, hábitos parafuncionais ou trauma; (iv) o resultado estético ' +
          'final é definido em conjunto com o profissional após análise do sorriso e cor base. ' +
          'Manutenções semestrais são recomendadas. A garantia técnica de execução é de 6 meses.',
      },
      LAMINADOS_CERAMICOS: {
        title: 'Termo de Laminados Cerâmicos / Lentes de Contato Dental',
        body:
          'Os laminados cerâmicos (lentes de contato dental) são restaurações estéticas ' +
          'definitivas executadas em cerâmica de alta resistência. Declaro estar ciente de que: ' +
          '(i) o procedimento envolve desgaste mínimo do esmalte dental, irreversível; (ii) o ' +
          'resultado final (cor, formato) é aprovado em fase de mock-up antes da cimentação ' +
          'definitiva; (iii) após cimentação, ajustes maiores não são possíveis sem refazer a ' +
          'peça; (iv) a garantia da CONTRATADA é de 12 meses para fraturas decorrentes de ' +
          'defeito de material ou execução, desde que respeitados os cuidados orientados; (v) ' +
          'devo evitar morder objetos duros, roer unhas e abrir embalagens com os dentes — ' +
          'tais hábitos podem fraturar as peças e não são cobertos por garantia.',
      },
      PROTESE: {
        title: 'Termo de Prótese Dentária',
        body:
          'A reabilitação protética envolve etapas de moldagem, prova, ajustes e instalação ' +
          'definitiva. Declaro estar ciente de que: (i) próteses removíveis (parciais ou totais) ' +
          'exigem período de adaptação que pode levar dias ou semanas; (ii) ajustes pós-instalação ' +
          'são comuns e estão inclusos no valor; (iii) próteses fixas (coroas, pontes) podem ' +
          'apresentar sensibilidade temporária após instalação; (iv) a higiene rigorosa é ' +
          'fundamental — uso de fio dental ou passa-fio diário previne cárie nos dentes pilares; ' +
          '(v) revisões semestrais são obrigatórias para verificar oclusão, ajustes e saúde dos ' +
          'tecidos de suporte. A garantia técnica do trabalho é de 12 meses.',
      },
      ENDODONTIA_ADULTO: {
        title: 'Termo de Endodontia (Tratamento de Canal) — Adulto',
        body:
          'O tratamento endodôntico (canal) é indicado quando a polpa dentária está irreversivelmente ' +
          'comprometida por cárie profunda, trauma ou inflamação. Declaro estar ciente de que: (i) ' +
          'o tratamento pode exigir 1 a 4 sessões dependendo da complexidade; (ii) há possibilidade ' +
          'de sensibilidade pós-operatória que pode durar dias; (iii) a taxa de sucesso é alta ' +
          '(>90%) mas há risco de re-tratamento ou perda do dente em casos complexos; (iv) o dente ' +
          'tratado endodonticamente fica mais frágil e geralmente necessita de coroa protética após ' +
          'o procedimento; (v) seguirei rigorosamente as orientações pós-operatórias e retornarei ' +
          'para acompanhamento radiográfico em 6 meses.',
      },
      ENDODONTIA_MENOR: {
        title: 'Termo de Endodontia (Tratamento de Canal) — Paciente Menor',
        body:
          'Considerando que o CONTRATANTE é menor de 18 anos, o responsável legal autoriza a ' +
          'execução do tratamento endodôntico (canal) descrito neste contrato. O tratamento ' +
          'pode envolver técnicas adaptadas à idade do paciente (apexificação, pulpotomia ' +
          'parcial, etc) dependendo do desenvolvimento radicular. Declaro estar ciente dos ' +
          'mesmos riscos descritos no termo de endodontia adulto, com a particularidade de ' +
          'que o acompanhamento clínico e radiográfico pode se estender por anos até o ' +
          'completo desenvolvimento da raiz. Comprometo-me a comparecer às consultas de ' +
          'controle agendadas.\n\n' +
          'Nome do responsável legal: _____________________________________________\n' +
          'CPF: __________________________ · Grau de parentesco: ______________________',
      },
      EXTRACAO_ADULTO: {
        title: 'Termo de Extração Dental — Adulto',
        body:
          'A exodontia (extração dentária) é indicada quando o dente não pode ser tratado ' +
          'conservadoramente ou compromete os demais. Declaro estar ciente de que: (i) podem ' +
          'ocorrer sangramento, edema, dor e equimose nos dias seguintes ao procedimento; (ii) ' +
          'há risco — embora baixo — de complicações como alveolite, comunicação bucossinusal ' +
          '(dentes superiores) e parestesia (dentes inferiores próximos ao nervo); (iii) devo ' +
          'seguir rigorosamente as orientações pós-operatórias: dieta fria/pastosa nas 24h, ' +
          'evitar bochechos vigorosos, não fumar e tomar a medicação prescrita; (iv) a ausência ' +
          'do dente pode comprometer função mastigatória e estética — a reabilitação (implante, ' +
          'prótese) deve ser planejada o quanto antes para evitar movimentação dos vizinhos.',
      },
      EXTRACAO_MENOR: {
        title: 'Termo de Extração Dental — Paciente Menor',
        body:
          'Considerando que o CONTRATANTE é menor de 18 anos, o responsável legal autoriza ' +
          'a execução da exodontia descrita neste contrato. Declaro estar ciente de que: (i) ' +
          'a indicação de extração em pacientes menores pode estar relacionada a dentes ' +
          'decíduos persistentes, supranumerários, ortodontia ou impactação; (ii) o protocolo ' +
          'pós-operatório deve ser rigorosamente acompanhado por adulto; (iii) há risco de ' +
          'alterações no desenvolvimento da arcada se o caso não for adequadamente acompanhado; ' +
          '(iv) ortodontia preventiva ou interceptiva pode ser indicada após a extração.\n\n' +
          'Nome do responsável legal: _____________________________________________\n' +
          'CPF: __________________________ · Grau de parentesco: ______________________',
      },
      IMPLANTE: {
        title: 'Termo de Implante Dentário',
        body:
          'A reabilitação com implante dentário envolve etapas cirúrgicas e protéticas. Declaro ' +
          'estar ciente de que: (i) o prazo médio entre o implante e a colocação da prótese ' +
          'definitiva é de 3 a 8 meses, dependendo da osseointegração; (ii) a taxa de sucesso ' +
          'é alta (>95%), mas há risco de rejeição ou perda do implante por fatores biológicos ' +
          'individuais; (iii) tabagismo, diabetes descompensado, bruxismo e má higiene aumentam ' +
          'o risco de complicações — devo informar essas condições à equipe; (iv) o pós-operatório ' +
          'imediato (edema, dor leve, hematoma) é esperado e controlável com medicação prescrita; ' +
          '(v) a higiene em torno do implante é crítica — peri-implantite por má higiene NÃO está ' +
          'coberta pela garantia; (vi) seguirei rigorosamente as orientações pós-cirúrgicas e ' +
          'comparecerei às consultas de controle agendadas; (vii) a garantia técnica do implante ' +
          'é de 5 anos contra falhas de osseointegração; a garantia da prótese sobre o implante ' +
          'é de 12 meses.',
      },
      RESTAURACAO: {
        title: 'Termo de Restauração Dental',
        body:
          'As restaurações diretas (em resina composta) ou indiretas (inlays/onlays/coroas) ' +
          'reestabelecem a forma e função de dentes comprometidos por cárie ou trauma. Declaro ' +
          'estar ciente de que: (i) a longevidade média das restaurações em resina é de 5 a 10 ' +
          'anos, dependendo do tamanho da cavidade, oclusão e hábitos; (ii) pode haver ' +
          'sensibilidade temporária após o procedimento, especialmente em restaurações profundas; ' +
          '(iii) restaurações extensas podem evoluir para necessidade de coroa protética ou ' +
          'tratamento endodôntico no futuro; (iv) a higiene oral e uso de fio dental são ' +
          'essenciais para evitar cárie recorrente nas bordas da restauração; (v) revisões ' +
          'semestrais permitem detectar e tratar precocemente falhas. A garantia técnica de ' +
          'execução é de 12 meses contra fraturas ou desadaptação.',
      },
    };
    return map[docId] || null;
  }
}
