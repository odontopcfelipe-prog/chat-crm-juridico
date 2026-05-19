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
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ContractPdfService {
  private readonly logger = new Logger(ContractPdfService.name);

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

    return this.renderPdf(contract, tenantInfo);
  }

  private renderPdf(
    contract: any,
    tenant: { name: string | null; cnpj: string | null; address: string | null; phone: string | null; email: string | null },
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
}
