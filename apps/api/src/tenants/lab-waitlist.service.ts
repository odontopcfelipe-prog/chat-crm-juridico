import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { brazilPhoneMatchVariants, toAlertPhone } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService, publicWebUrl } from '../common/mail/mail.service';

/** Mesmo WhatsApp de novo dentro desse prazo não vira linha nova. */
const JANELA_REPETIDA_MS = 30 * 24 * 3600_000;
/** Teto de inscrições novas nas últimas 24 h (todas juntas). Acima disso nada é gravado, só registrado no log. */
export const TETO_POR_DIA = 100;
/** No máximo 1 e-mail de aviso por hora, por mais inscrições que cheguem. */
const AVISO_A_CADA_MS = 3600_000;

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

/**
 * Lista de espera do caminho "Laboratório de prótese" no /cadastrar. Ninguém ganha
 * conta aqui: só guarda o contato (tabela da plataforma, sem conta) e avisa os
 * SUPER_ADMIN por e-mail — no máximo 1 por hora, sem nada do que foi digitado
 * (os dados ficam só em Admin SaaS → Lista de espera). A resposta é sempre a mesma.
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
    const phone = toAlertPhone(texto(dados.phone, 40));
    if (!phone) throw new BadRequestException('Informe um WhatsApp com DDD');
    const email = texto(dados.email, 160).toLowerCase() || null;
    const city = texto(dados.city, 80) || null;

    const agora = Date.now();
    const repetida = await this.prisma.labWaitlistEntry.findFirst({
      where: {
        phone: { in: brazilPhoneMatchVariants(phone) },
        created_at: { gte: new Date(agora - JANELA_REPETIDA_MS) },
      },
      select: { id: true },
    });
    if (repetida) return { ok: true };

    const noDia = await this.prisma.labWaitlistEntry.count({
      where: { created_at: { gte: new Date(agora - 24 * 3600_000) } },
    });
    if (noDia >= TETO_POR_DIA) {
      this.logger.warn(`[LISTA-ESPERA] teto de ${TETO_POR_DIA} inscrições em 24 h atingido; inscrição não gravada`);
      return { ok: true };
    }
    const avisoRecente = await this.prisma.labWaitlistEntry.findFirst({
      where: { created_at: { gte: new Date(agora - AVISO_A_CADA_MS) } },
      select: { id: true },
    });

    await this.prisma.labWaitlistEntry.create({
      data: { lab_name: labName, contact_name: contactName, phone, email, city },
    });
    // Fora do tempo da resposta: SMTP lento ou fora do ar não atrasa nem derruba a inscrição.
    if (!avisoRecente) void this.avisarDono();
    return { ok: true };
  }

  listar() {
    return this.prisma.labWaitlistEntry.findMany({ orderBy: { created_at: 'desc' }, take: 500 });
  }

  async remover(id: string): Promise<{ removidos: number }> {
    const { count } = await this.prisma.labWaitlistEntry.deleteMany({ where: { id } });
    return { removidos: count };
  }

  /** E-mail aos SUPER_ADMIN, só com texto fixo. Nunca lança. */
  private async avisarDono(): Promise<void> {
    try {
      const destinos = await this.prisma.user.findMany({
        where: { roles: { has: 'SUPER_ADMIN' }, email: { not: '' } },
        select: { email: true },
      });
      const emails = [...new Set(destinos.map((d) => d.email).filter((e): e is string => !!e))];
      if (!emails.length) return;
      const corpo = this.mail.renderTemplate({
        title: 'Novo laboratório na lista de espera',
        bodyHtml: 'Um laboratório de prótese entrou na lista de espera pelo /cadastrar. Os dados estão em Admin SaaS → Lista de espera.',
        ctaLabel: 'Ver a lista de espera',
        ctaUrl: `${publicWebUrl()}/admin/lista-espera`,
        footerNote: 'No máximo 1 aviso por hora; as inscrições seguintes aparecem direto na lista.',
      });
      for (const to of emails) {
        await this.mail.send({ to, subject: 'Novo laboratório na lista de espera', html: corpo }).catch((e) => {
          this.logger.warn(`[LISTA-ESPERA] e-mail para ${to} falhou: ${e?.message}`);
        });
      }
    } catch (e: any) {
      this.logger.warn(`[LISTA-ESPERA] aviso por e-mail falhou: ${e?.message}`);
    }
  }
}
