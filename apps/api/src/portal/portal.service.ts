import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnamnesisService } from '../anamnesis/anamnesis.service';

/**
 * Texto fixo do termo de consentimento aceito pelo paciente ao confirmar
 * a anamnese. Versao 1 — alterar este texto exige bump de versao para nao
 * invalidar provas anteriores. Snapshot e salvo em Anamnesis.consent_text.
 */
export const ANAMNESE_CONSENT_TEXT_V1 =
  'Declaro, sob minha responsabilidade, que as informacoes prestadas nesta ' +
  'anamnese sao verdadeiras e completas. Estou ciente de que a omissao ou ' +
  'falsidade de dados pode prejudicar meu diagnostico e tratamento, e ' +
  'autorizo o uso destas informacoes pelos profissionais da clinica para ' +
  'fins clinicos e de prontuario, conforme LGPD (Lei 13.709/2018). ' +
  'Confirmo eletronicamente este preenchimento, ciente de que data, hora, ' +
  'IP e dispositivo de acesso ficarao registrados como prova de autoria.';

/**
 * Servico de leitura/acoes do portal do paciente. Todas as funcoes
 * recebem patient_id+tenant_id que vem do PortalJwtGuard, garantindo
 * que paciente so ve seus proprios dados.
 */
@Injectable()
export class PortalService {
  constructor(
    private prisma: PrismaService,
    private anamnesisService: AnamnesisService,
  ) {}

  async getMe(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        cpf: true,
        birth_date: true,
        primary_dentist: { select: { id: true, name: true } },
        _count: { select: { appointments: true, installments: true, anamneses: true } },
      },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    return patient;
  }

  /** Proxima consulta + ultimas 5 (futuras + recentes). */
  async getAppointments(tenantId: string, patientId: string) {
    const now = new Date();
    const [upcoming, past] = await Promise.all([
      this.prisma.calendarEvent.findMany({
        where: {
          tenant_id: tenantId,
          patient_id: patientId,
          start_at: { gte: now },
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
        },
        orderBy: { start_at: 'asc' },
        take: 10,
        select: {
          id: true,
          title: true,
          description: true,
          start_at: true,
          end_at: true,
          status: true,
          assigned_user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.calendarEvent.findMany({
        where: {
          tenant_id: tenantId,
          patient_id: patientId,
          start_at: { lt: now },
        },
        orderBy: { start_at: 'desc' },
        take: 5,
        select: {
          id: true,
          title: true,
          start_at: true,
          status: true,
          assigned_user: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { upcoming, past };
  }

  /** Confirma consulta — paciente clicou 'Vou comparecer'. */
  async confirmAppointment(tenantId: string, patientId: string, appointmentId: string) {
    const ev = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId, patient_id: patientId },
    });
    if (!ev) throw new NotFoundException('Agendamento nao encontrado');
    if (ev.status === 'CANCELADO') throw new BadRequestException('Consulta cancelada');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.calendarEvent.update({
        where: { id: ev.id },
        data: { status: 'CONFIRMADO' },
      });
      // Marca tambem a confirmacao mais recente (se houver) como respondida
      const latest = await tx.appointmentConfirmation.findFirst({
        where: { appointment_id: ev.id, response_status: 'PENDENTE' },
        orderBy: { created_at: 'desc' },
      });
      if (latest) {
        await tx.appointmentConfirmation.update({
          where: { id: latest.id },
          data: {
            response_status: 'CONFIRMADO',
            response_at: new Date(),
            response_text: '[Confirmado via portal]',
          },
        });
      }
      return updated;
    });
  }

  /** Cancela consulta — paciente nao podera comparecer. */
  async cancelAppointment(tenantId: string, patientId: string, appointmentId: string, reason?: string) {
    const ev = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId, patient_id: patientId },
    });
    if (!ev) throw new NotFoundException('Agendamento nao encontrado');
    if (ev.status === 'CANCELADO') return ev;
    if (ev.status === 'CONCLUIDO') throw new BadRequestException('Consulta ja realizada');

    return this.prisma.calendarEvent.update({
      where: { id: ev.id },
      data: {
        status: 'CANCELADO',
        description: ev.description
          ? `${ev.description}\n\n[Cancelado pelo paciente: ${reason || 'sem motivo'}]`
          : `[Cancelado pelo paciente: ${reason || 'sem motivo'}]`,
      },
    });
  }

  /** Lista parcelas (abertas + recentes pagas). */
  async getInstallments(tenantId: string, patientId: string) {
    const installments = await this.prisma.installment.findMany({
      where: { tenant_id: tenantId, patient_id: patientId },
      orderBy: [{ status: 'asc' }, { due_date: 'asc' }],
      take: 50,
      select: {
        id: true,
        sequence: true,
        total_count: true,
        amount: true,
        amount_paid: true,
        due_date: true,
        paid_at: true,
        payment_method: true,
        status: true,
      },
    });

    const totals = installments.reduce(
      (acc, i) => {
        const remaining = Number(i.amount) - Number(i.amount_paid);
        if (i.status === 'PAGA') acc.paid += Number(i.amount_paid);
        else if (i.status === 'ABERTA' || i.status === 'PARCIAL' || i.status === 'ATRASADA') {
          acc.open += remaining;
          if (new Date(i.due_date) < new Date()) acc.overdue += remaining;
        }
        return acc;
      },
      { paid: 0, open: 0, overdue: 0 },
    );

    return { installments, totals };
  }

  /** Lista anamneses (preenchidas + pendentes). */
  async getAnamneses(tenantId: string, patientId: string) {
    return this.prisma.anamnesis.findMany({
      where: {
        patient: { id: patientId, tenant_id: tenantId },
      },
      orderBy: { filled_at: 'desc' },
      take: 10,
      select: {
        id: true,
        filled_at: true,
        updated_at: true,
        template: { select: { id: true, version: true } },
      },
    });
  }

  /**
   * Retorna anamnese ativa do paciente OU template ativo se ainda nao existe.
   * Usado pelo portal para o paciente preencher/revisar sua anamnese.
   * Inclui consent_text v1 para o front exibir.
   */
  async getActiveAnamneseForPatient(tenantId: string, patientId: string) {
    const data = await this.anamnesisService.findActiveByPatient(patientId, tenantId);
    return {
      ...data,
      consent_text: ANAMNESE_CONSENT_TEXT_V1,
    };
  }

  /**
   * Paciente submete/atualiza anamnese pelo portal. Captura IP + user-agent
   * + assinatura digitada + texto de consentimento. Persiste audit_hash
   * SHA-256 como fingerprint imutavel para futura comprovacao.
   */
  async submitAnamneseByPatient(
    tenantId: string,
    patientId: string,
    body: {
      answers: Record<string, any>;
      signature_data: string;
      signature_method?: 'TYPED_NAME' | 'DRAWN';
      consent_accepted: boolean;
    },
    ip?: string,
    userAgent?: string,
  ) {
    if (!body?.consent_accepted) {
      throw new BadRequestException('E necessario aceitar o termo de consentimento');
    }
    if (!body.signature_data || body.signature_data.trim().length < 3) {
      throw new BadRequestException('Assinatura obrigatoria (digite seu nome completo)');
    }
    if (!body.answers || typeof body.answers !== 'object') {
      throw new BadRequestException('answers obrigatorio');
    }

    return this.anamnesisService.upsertByPatient(
      patientId,
      tenantId,
      {
        answers: body.answers,
        submitted_via: 'PATIENT_PORTAL',
        ip,
        user_agent: userAgent,
        consent_text: ANAMNESE_CONSENT_TEXT_V1,
        signature_method: body.signature_method || 'TYPED_NAME',
        signature_data: body.signature_data.trim(),
      },
      undefined, // sem userId — paciente, nao funcionario
    );
  }
}
