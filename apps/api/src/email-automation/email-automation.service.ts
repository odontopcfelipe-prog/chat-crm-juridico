import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail/mail.service';
import { EMAIL_EVENTS, getEmailEvent } from './email-events';

/**
 * Onda 17.32.181 — E-mails automaticos por tenant (estilo Nuvemshop).
 *
 * dispatch() e chamado pelos gatilhos (cobranca criada, pagamento
 * confirmado, agendamento criado) SEMPRE em modo best-effort: falha de
 * e-mail nunca quebra a operacao de negocio.
 *
 * Remetente: o sistema envia pela infra da plataforma, mas com nome de
 * exibicao da CLINICA e Reply-To no e-mail cadastrado do tenant — o
 * paciente ve a clinica e, ao responder, cai na caixa dela.
 */

export interface DispatchVars {
  [key: string]: string | undefined;
}

@Injectable()
export class EmailAutomationService {
  private readonly logger = new Logger(EmailAutomationService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
  ) {}

  /** Lista os eventos com defaults aplicados + overrides do tenant. */
  async listForTenant(tenantId: string) {
    const overrides = await this.prisma.tenantEmailTemplate.findMany({
      where: { tenant_id: tenantId },
    });
    const byKey = new Map(overrides.map((o) => [o.event_key, o]));
    return EMAIL_EVENTS.map((def) => {
      const ov = byKey.get(def.key);
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        variables: def.variables,
        enabled: ov ? ov.enabled : true,
        subject: ov ? ov.subject : def.defaultSubject,
        body: ov ? ov.body : def.defaultBody,
        is_customized: !!ov,
      };
    });
  }

  /** Salva o override do tenant pra um evento. */
  async update(
    tenantId: string,
    eventKey: string,
    data: { enabled?: boolean; subject?: string; body?: string },
  ) {
    const def = getEmailEvent(eventKey);
    if (!def) throw new BadRequestException(`Evento desconhecido: ${eventKey}`);

    const existing = await this.prisma.tenantEmailTemplate.findUnique({
      where: { tenant_id_event_key: { tenant_id: tenantId, event_key: eventKey } },
    });

    const subject = (data.subject ?? existing?.subject ?? def.defaultSubject).trim();
    const body = (data.body ?? existing?.body ?? def.defaultBody).trim();
    if (!subject) throw new BadRequestException('O assunto não pode ficar vazio.');
    if (!body) throw new BadRequestException('O conteúdo não pode ficar vazio.');

    const saved = await this.prisma.tenantEmailTemplate.upsert({
      where: { tenant_id_event_key: { tenant_id: tenantId, event_key: eventKey } },
      update: { enabled: data.enabled ?? existing?.enabled ?? true, subject, body },
      create: {
        tenant_id: tenantId,
        event_key: eventKey,
        enabled: data.enabled ?? true,
        subject,
        body,
      },
    });
    return saved;
  }

  /** Remove o override — o evento volta pro template padrao do sistema. */
  async resetToDefault(tenantId: string, eventKey: string) {
    const def = getEmailEvent(eventKey);
    if (!def) throw new BadRequestException(`Evento desconhecido: ${eventKey}`);
    await this.prisma.tenantEmailTemplate.deleteMany({
      where: { tenant_id: tenantId, event_key: eventKey },
    });
    return { ok: true };
  }

  /** Envia o template (com valores de exemplo) pro e-mail do admin. */
  async sendTest(tenantId: string, eventKey: string, toEmail: string) {
    const def = getEmailEvent(eventKey);
    if (!def) throw new BadRequestException(`Evento desconhecido: ${eventKey}`);
    const vars: DispatchVars = {};
    for (const v of def.variables) vars[v.name] = v.sample;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, email: true },
    });
    if (tenant?.name) vars.clinica_nome = tenant.name;
    const sent = await this.dispatch(eventKey, tenantId, toEmail, vars, {
      ctaUrl: def.ctaLabel ? 'https://sistema.institutoodontopassos.com.br' : undefined,
      ignoreDisabled: true,
    });
    if (!sent) {
      throw new BadRequestException('SMTP do sistema não configurado — fale com o suporte.');
    }
    return { ok: true };
  }

  /**
   * Dispara um e-mail automatico. Retorna true se enviou.
   * NUNCA lanca (uso em gatilhos de negocio) — exceto quando chamado
   * pelo sendTest (que trata o retorno).
   */
  async dispatch(
    eventKey: string,
    tenantId: string,
    toEmail: string | null | undefined,
    vars: DispatchVars,
    opts?: { ctaUrl?: string; ignoreDisabled?: boolean },
  ): Promise<boolean> {
    try {
      const def = getEmailEvent(eventKey);
      if (!def || !toEmail || !tenantId) return false;

      const override = await this.prisma.tenantEmailTemplate.findUnique({
        where: { tenant_id_event_key: { tenant_id: tenantId, event_key: eventKey } },
      });
      if (override && !override.enabled && !opts?.ignoreDisabled) {
        return false; // tenant desligou esse e-mail
      }

      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, email: true },
      });
      const clinicName = tenant?.name || 'Odonto System';
      const allVars: DispatchVars = { clinica_nome: clinicName, ...vars };

      const subject = this.render(override?.subject ?? def.defaultSubject, allVars);
      const bodyText = this.render(override?.body ?? def.defaultBody, allVars);
      const bodyHtml = this.escapeHtml(bodyText).replace(/\n/g, '<br>');

      const html = this.mail.renderTemplate({
        title: subject,
        bodyHtml,
        ctaLabel: opts?.ctaUrl && def.ctaLabel ? def.ctaLabel : undefined,
        ctaUrl: opts?.ctaUrl,
        brandName: clinicName,
      });

      const sent = await this.mail.send({
        to: toEmail,
        subject,
        html,
        fromName: clinicName,
        replyTo: tenant?.email || undefined,
      });
      if (sent) {
        this.logger.log(`[AUTO-MAIL] ${eventKey} enviado pra ${toEmail} (tenant ${tenantId})`);
      }
      return sent;
    } catch (e: any) {
      this.logger.warn(`[AUTO-MAIL] Falha em ${eventKey} pra ${toEmail}: ${e?.message}`);
      return false;
    }
  }

  /**
   * Onda 17.32.182 — Lembrete "vence amanha": cron diario as 09:00
   * (America/Maceio) que varre cobrancas PENDING com vencimento no dia
   * seguinte e dispara o e-mail. Dedup via due_reminder_sent_at —
   * marcado SO quando o envio acontece, entao falha de SMTP tenta de
   * novo no dia seguinte (enquanto ainda estiver na janela).
   */
  @Cron('0 9 * * *', { timeZone: 'America/Maceio' })
  async sendDueTomorrowReminders(): Promise<void> {
    try {
      // America/Maceio = UTC-3 fixo (sem horario de verao)
      const OFFSET_MS = 3 * 60 * 60 * 1000;
      const DAY_MS = 24 * 60 * 60 * 1000;
      const nowLocal = new Date(Date.now() - OFFSET_MS);
      const tomorrowLocalMidnight = Date.UTC(
        nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate(),
      ) + DAY_MS;
      const start = new Date(tomorrowLocalMidnight + OFFSET_MS);
      const end = new Date(start.getTime() + DAY_MS);

      const charges = await this.prisma.paymentGatewayCharge.findMany({
        where: {
          status: 'PENDING',
          due_reminder_sent_at: null,
          due_date: { gte: start, lt: end },
          installment_id: { not: null },
          tenant_id: { not: null },
        },
        select: {
          id: true,
          tenant_id: true,
          amount: true,
          due_date: true,
          billing_type: true,
          invoice_url: true,
          boleto_url: true,
          installment: { select: { patient: { select: { name: true, email: true } } } },
        },
      });
      if (charges.length === 0) return;
      this.logger.log(`[AUTO-MAIL] vencimento_proximo: ${charges.length} cobranca(s) vencem amanha`);

      for (const c of charges) {
        const patient = c.installment?.patient;
        if (!patient?.email) continue;
        const sent = await this.dispatch(
          'vencimento_proximo',
          c.tenant_id!,
          patient.email,
          {
            paciente_nome: patient.name,
            valor: Number(c.amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
            vencimento: new Date(c.due_date).toLocaleDateString('pt-BR'),
            forma_pagamento: c.billing_type === 'CREDIT_CARD' ? 'Cartão' : c.billing_type === 'BOLETO' ? 'Boleto' : 'PIX',
          },
          { ctaUrl: c.invoice_url || c.boleto_url || undefined },
        );
        if (sent) {
          await this.prisma.paymentGatewayCharge.update({
            where: { id: c.id },
            data: { due_reminder_sent_at: new Date() },
          });
        }
      }
    } catch (e: any) {
      this.logger.error(`[AUTO-MAIL] cron vencimento_proximo falhou: ${e?.message}`);
    }
  }

  /** Substitui {{variavel}} (espacos opcionais). Var desconhecida vira ''. */
  private render(template: string, vars: DispatchVars): string {
    return template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, name) => vars[name] ?? '');
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
