import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { contaDoLabPodeEnviar, excludeLabWhere, getLabTenantIds, isLabTenant } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail/mail.service';
import { LimitePorConta } from '../common/limite-por-conta';
import { EMAIL_EVENTS, getEmailEvent } from './email-events';
// Laboratório de prótese — texto sem vocabulário de clínica (funções puras, sem DI).
import { semVariaveis, temVocabularioDeClinica } from '../payment-gateway/cobranca-laboratorio';
// Laboratório de prótese — catálogo dos e-mails com o texto do laboratório.
import { LAB_EMAILS_LIGADOS_POR_PADRAO, LAB_EMAIL_ERROS, LAB_EMAIL_EVENTS } from './lab-email-events-textos';

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

/** E-mails de teste por conta de laboratório. */
export const LIMITE_DE_TESTE_DO_LAB = new LimitePorConta(5, 86_400_000, LAB_EMAIL_ERROS.limiteDeTeste);

/** Texto do evento no laboratório (null = evento sem versão de laboratório). */
function eventoDoLaboratorio(key: string): (typeof LAB_EMAIL_EVENTS)[keyof typeof LAB_EMAIL_EVENTS] | null {
  return (LAB_EMAIL_EVENTS as Record<string, (typeof LAB_EMAIL_EVENTS)[keyof typeof LAB_EMAIL_EVENTS]>)[key] ?? null;
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
    // Laboratório: o texto e as variáveis do laboratório; um e-mail que a conta ainda não
    // ligou aparece desligado. Clínica: só a leitura da lista de laboratórios (cache).
    const lab = await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
    return EMAIL_EVENTS.map((def) => {
      const ov = byKey.get(def.key);
      const labDef = lab ? eventoDoLaboratorio(def.key) : null;
      if (labDef) {
        return {
          key: def.key,
          label: labDef.label,
          description: labDef.description,
          variables: labDef.variables,
          enabled: ov ? ov.enabled : LAB_EMAILS_LIGADOS_POR_PADRAO.has(def.key),
          subject: ov ? ov.subject : labDef.defaultSubject,
          body: ov ? ov.body : labDef.defaultBody,
          is_customized: !!ov,
        };
      }
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

    // Laboratório: parte do texto do laboratório e não aceita palavra de clínica; o e-mail
    // ainda não ligado fica desligado até a conta ligar.
    const lab = await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
    const labDef = lab ? eventoDoLaboratorio(eventKey) : null;
    const subject = (data.subject ?? existing?.subject ?? labDef?.defaultSubject ?? def.defaultSubject).trim();
    const body = (data.body ?? existing?.body ?? labDef?.defaultBody ?? def.defaultBody).trim();
    if (!subject) throw new BadRequestException('O assunto não pode ficar vazio.');
    if (!body) throw new BadRequestException('O conteúdo não pode ficar vazio.');
    if (lab && temVocabularioDeClinica(semVariaveis(`${subject}\n${body}`))) {
      throw new BadRequestException(LAB_EMAIL_ERROS.textoDeClinica);
    }
    const ligadoPadrao = lab ? LAB_EMAILS_LIGADOS_POR_PADRAO.has(eventKey) : true;

    const saved = await this.prisma.tenantEmailTemplate.upsert({
      where: { tenant_id_event_key: { tenant_id: tenantId, event_key: eventKey } },
      update: { enabled: data.enabled ?? existing?.enabled ?? ligadoPadrao, subject, body },
      create: {
        tenant_id: tenantId,
        event_key: eventKey,
        enabled: data.enabled ?? ligadoPadrao,
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
    const lab = await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
    if (lab) LIMITE_DE_TESTE_DO_LAB.consumir(tenantId);
    const labDef = lab ? eventoDoLaboratorio(eventKey) : null;
    for (const v of labDef ? labDef.variables : def.variables) vars[v.name] = v.sample;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, email: true },
    });
    if (tenant?.name) vars.clinica_nome = tenant.name;
    // Laboratório em teste grátis: o teste sai com o texto padrão, nunca com o editado.
    const emTrial = lab && (await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }))?.status === 'TRIAL';
    const sent = await this.dispatch(eventKey, tenantId, toEmail, vars, {
      ctaUrl: def.ctaLabel ? 'https://sistema.institutoodontopassos.com.br' : undefined,
      ignoreDisabled: true,
      ...(emTrial ? { soTextoPadrao: true } : {}),
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
    opts?: { ctaUrl?: string; ignoreDisabled?: boolean; soTextoPadrao?: boolean },
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
      const editado = opts?.soTextoPadrao ? null : override;

      // Laboratório de prótese: usa o texto do laboratório; o e-mail que a conta ainda não
      // ligou não sai (só cobrança criada e pagamento confirmado já saíam ligados); texto
      // com palavra de clínica (consulta, paciente, tratamento…) também não sai.
      // Clínica: só a leitura da lista de laboratórios (cache).
      const lab = await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
      const labDef = lab ? eventoDoLaboratorio(eventKey) : null;
      if (lab) {
        // Conta suspensa ou congelada: nenhum e-mail automático sai (o lembrete de vencimento
        // só marca enviado quando sai de verdade, então não fica nada travado).
        if (!(await contaDoLabPodeEnviar(this.prisma, tenantId))) {
          this.logger.log(`[LAB] email — ${eventKey}: conta de laboratório ${tenantId} suspensa, não sai`);
          return false;
        }
        if (!override && !opts?.ignoreDisabled && !LAB_EMAILS_LIGADOS_POR_PADRAO.has(eventKey)) {
          this.logger.log(`[LAB] email — ${eventKey} desligado na conta de laboratório ${tenantId}: não sai`);
          return false;
        }
        if (
          temVocabularioDeClinica(
            semVariaveis(`${editado?.subject ?? labDef?.defaultSubject ?? def.defaultSubject}\n${editado?.body ?? labDef?.defaultBody ?? def.defaultBody}`),
          )
        ) {
          this.logger.log(`[LAB-GATE] email — ${eventKey} tem texto de clínica: não sai na conta de laboratório ${tenantId}`);
          return false;
        }
      }

      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, email: true },
      });
      const clinicName = tenant?.name || 'Odonto System';
      // No laboratório o cliente é {{cliente_nome}} (o gatilho de cobrança ainda manda paciente_nome).
      const allVars: DispatchVars = { clinica_nome: clinicName, ...(lab ? { cliente_nome: vars.paciente_nome } : {}), ...vars };

      const subject = this.render(editado?.subject ?? labDef?.defaultSubject ?? def.defaultSubject, allVars);
      const bodyText = this.render(editado?.body ?? labDef?.defaultBody ?? def.defaultBody, allVars);
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

      // Laboratório: a cobrança dele só entra se a PRÓPRIA conta ligou o e-mail "vencimento
      // amanhã" (linha da conta com enabled=true); sem isso fica fora da busca. Clínica:
      // sem laboratório o where é o mesmo objeto (com o `tenant_id not null` de sempre, o
      // resultado é só o notIn).
      const todosLabs = await getLabTenantIds(this.prisma, (m) => this.logger.warn(m));
      let labs: ReadonlySet<string> = todosLabs;
      if (todosLabs.size) {
        const ligados = await this.prisma.tenantEmailTemplate.findMany({
          where: { event_key: 'vencimento_proximo', enabled: true, tenant_id: { in: [...todosLabs] } },
          select: { tenant_id: true },
        });
        if (ligados.length) {
          const optaram = new Set(ligados.map((l) => l.tenant_id));
          labs = new Set([...todosLabs].filter((id) => !optaram.has(id)));
        }
      }
      if (labs.size) this.logger.log(`[LAB] vencimento-email — ${labs.size} laboratório(s) sem o e-mail ligado, fora da busca`);
      const charges = await this.prisma.paymentGatewayCharge.findMany({
        where: excludeLabWhere('paymentGatewayCharge', {
          status: 'PENDING',
          due_reminder_sent_at: null,
          due_date: { gte: start, lt: end },
          installment_id: { not: null },
          tenant_id: { not: null },
        }, labs),
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
