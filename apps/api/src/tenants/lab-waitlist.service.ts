import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { brazilPhoneMatchVariants, toBrazilWhatsappNumber } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail/mail.service';

/** Mesmo WhatsApp de novo dentro desse prazo não vira linha nova nem e-mail. */
const JANELA_REPETIDA_MS = 30 * 24 * 3600_000;

export interface InscricaoLaboratorio {
  lab_name: string;
  contact_name: string;
  phone: string;
  email?: string;
  city?: string;
  /** Campo escondido na tela: só robô preenche. */
  website?: string;
}

const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

const html = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/**
 * Lista de espera do caminho "Laboratório de prótese" no /cadastrar. Ninguém ganha
 * conta aqui: só guarda o contato (tabela da plataforma, sem conta) e avisa os
 * SUPER_ADMIN por e-mail. A resposta é sempre a mesma, para não revelar quem já
 * está na lista.
 */
@Injectable()
export class LabWaitlistService {
  private readonly logger = new Logger(LabWaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async inscrever(dados: InscricaoLaboratorio): Promise<{ ok: true }> {
    if (texto(dados.website, 200)) return { ok: true };

    const labName = texto(dados.lab_name, 120);
    const contactName = texto(dados.contact_name, 120);
    if (labName.length < 2) throw new BadRequestException('Informe o nome do laboratório');
    if (contactName.length < 2) throw new BadRequestException('Informe o seu nome');
    const phone = toBrazilWhatsappNumber(texto(dados.phone, 40));
    if (!/^55\d{10,11}$/.test(phone)) throw new BadRequestException('Informe um WhatsApp com DDD');
    const email = texto(dados.email, 160).toLowerCase() || null;
    const city = texto(dados.city, 80) || null;

    const repetida = await this.prisma.labWaitlistEntry.findFirst({
      where: {
        phone: { in: brazilPhoneMatchVariants(phone) },
        created_at: { gte: new Date(Date.now() - JANELA_REPETIDA_MS) },
      },
      select: { id: true },
    });
    if (repetida) return { ok: true };

    await this.prisma.labWaitlistEntry.create({
      data: { lab_name: labName, contact_name: contactName, phone, email, city },
    });
    await this.avisarDono({ labName, contactName, phone, email, city });
    return { ok: true };
  }

  listar() {
    return this.prisma.labWaitlistEntry.findMany({ orderBy: { created_at: 'desc' }, take: 500 });
  }

  /** E-mail aos SUPER_ADMIN. Falha de e-mail nunca derruba a inscrição. */
  private async avisarDono(i: { labName: string; contactName: string; phone: string; email: string | null; city: string | null }) {
    try {
      const destinos = await this.prisma.user.findMany({
        where: { roles: { has: 'SUPER_ADMIN' }, email: { not: '' } },
        select: { email: true },
      });
      const emails = [...new Set(destinos.map((d) => d.email).filter((e): e is string => !!e))];
      if (!emails.length) return;
      const linhas = [
        `Laboratório: <b>${html(i.labName)}</b>`,
        `Contato: ${html(i.contactName)}`,
        `WhatsApp: ${html(i.phone)}`,
        i.email ? `E-mail: ${html(i.email)}` : '',
        i.city ? `Cidade: ${html(i.city)}` : '',
      ].filter(Boolean);
      const corpo = this.mail.renderTemplate({
        title: 'Novo laboratório na lista de espera',
        bodyHtml: linhas.join('<br>'),
        footerNote: 'Inscrição pelo /cadastrar (caminho Laboratório de prótese). A lista completa fica em Admin SaaS → Lista de espera.',
      });
      for (const to of emails) {
        await this.mail.send({ to, subject: `Lista de espera: ${i.labName}`, html: corpo }).catch((e) => {
          this.logger.warn(`[LISTA-ESPERA] e-mail para ${to} falhou: ${e?.message}`);
        });
      }
    } catch (e: any) {
      this.logger.warn(`[LISTA-ESPERA] aviso por e-mail falhou: ${e?.message}`);
    }
  }
}
