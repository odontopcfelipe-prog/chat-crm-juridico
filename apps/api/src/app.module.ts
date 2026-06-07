import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
// Onda 17.32.77 — SaaS Fase 1: gestao de Tenants (SUPER_ADMIN)
import { TenantsModule } from './tenants/tenants.module';
// Onda 17.32.112 — Anamnese MASTER controlada pelo SUPER_ADMIN
import { GlobalAnamnesisModule } from './global-anamnesis/global-anamnesis.module';
// Onda 17.32.86 — SaaS Fase 3b: cobranca da mensalidade
import { BillingModule } from './billing/billing.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { LeadsModule } from './leads/leads.module';
import { ConversationsModule } from './conversations/conversations.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { MessagesModule } from './messages/messages.module';
import { GatewayModule } from './gateway/gateway.module';
import { TasksModule } from './tasks/tasks.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { SettingsModule } from './settings/settings.module';
import { NotificationSettingsModule } from './notification-settings/notification-settings.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PushModule } from './push/push.module';
import { InboxesModule } from './inboxes/inboxes.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { MediaModule } from './media/media.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { TransferAudioModule } from './transfer-audio/transfer-audio.module';
import { CalendarModule } from './calendar/calendar.module';
import { WaitlistModule } from './waitlist/waitlist.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ContractsModule } from './contracts/contracts.module';
import { ClicksignModule } from './clicksign/clicksign.module';
import { S3Module } from './s3/s3.module';
import { McpModule } from './mcp/mcp.module';
import { AutomationsModule } from './automations/automations.module';
import { FollowupModule } from './followup/followup.module';
import { GoogleDriveModule } from './google-drive/google-drive.module';
import { InternModule } from './intern/intern.module';
import { AdminBotModule } from './admin-bot/admin-bot.module';
import { FinanceiroModule } from './financeiro/financeiro.module';
import { PaymentGatewayModule } from './payment-gateway/payment-gateway.module';
import { NotaFiscalModule } from './nota-fiscal/nota-fiscal.module';
import { MemoriesModule } from './memories/memories.module';
import { PatientsModule } from './patients/patients.module';
import { SpecialtiesModule } from './specialties/specialties.module';
import { ProceduresModule } from './procedures/procedures.module';
import { AnamnesisModule } from './anamnesis/anamnesis.module';
import { PostCareModule } from './post-care/post-care.module';
import { ClinicalRecordsModule } from './clinical-records/clinical-records.module';
import { OdontogramModule } from './odontogram/odontogram.module';
import { CommercialModule } from './commercial/commercial.module';
import { InventoryModule } from './inventory/inventory.module';
import { EstheticModule } from './esthetic/esthetic.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { AdverseReactionsModule } from './adverse-reactions/adverse-reactions.module';
import { AgendaExtendedModule } from './agenda-extended/agenda-extended.module';
import { CommissionsModule } from './commissions/commissions.module';
import { InstallmentsModule } from './installments/installments.module';
import { PortalModule } from './portal/portal.module';
import { ReportsModule } from './reports/reports.module';
import { ClinicsModule } from './clinics/clinics.module';
import { SmileDesignModule } from './smile-design/smile-design.module';
import { RadiographyModule } from './radiography/radiography.module';
import { PatientTagsModule } from './patient-tags/patient-tags.module';
import { ReferralsModule } from './referrals/referrals.module';
import { InfluencersModule } from './influencers/influencers.module';

import { HealthController } from './common/controllers/health.controller';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      useFactory: () => ({
        prefix: process.env.BULL_PREFIX || 'bull',
        connection: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
        },
      }),
    }),
    PrismaModule,
    TenantsModule,
    GlobalAnamnesisModule,
    BillingModule,
    S3Module,
    UsersModule,
    AuthModule,
    LeadsModule, 
    ConversationsModule,
    WebhooksModule,
    MessagesModule,
    GatewayModule,
    TasksModule,
    WhatsappModule,
    SettingsModule,
    InboxesModule,
    PipelinesModule,
    MediaModule,
    AnalyticsModule,
    TransferAudioModule,
    CalendarModule,
    WaitlistModule,
    GoogleDriveModule,
    DashboardModule,
    ContractsModule,
    ClicksignModule,
    McpModule,
    AutomationsModule,
    FollowupModule,
    InternModule,
    AdminBotModule,
    FinanceiroModule,
    PaymentGatewayModule,
    NotaFiscalModule,
    NotificationSettingsModule,
    NotificationsModule,
    PushModule,
    MemoriesModule,
    PatientsModule,
    SpecialtiesModule,
    ProceduresModule,
    AnamnesisModule,
    PostCareModule,
    ClinicalRecordsModule,
    OdontogramModule,
    CommercialModule,
    // Fase 6 — Estetica facial avancada + Estoque ANVISA
    InventoryModule,
    EstheticModule,
    AdverseReactionsModule,
    // Fase 25 Onda 5 — Manutencoes/Recall
    MaintenanceModule,
    // Fase 7 — Agenda evoluida
    AgendaExtendedModule,
    // Fase 8 — Comissoes + Metas
    CommissionsModule,
    // Fase 11 — Regua de cobranca
    InstallmentsModule,
    // Fase 13 — Portal do paciente (PWA)
    PortalModule,
    // Fase 14 — Hub de Relatorios
    ReportsModule,
    // Fase 15 — Multi-unidade / Franquias
    ClinicsModule,
    // Fase 16 — Smile/Face Design Studio
    SmileDesignModule,
    // Fase 17 — Integracao radiologia
    RadiographyModule,
    // Fase 20 — Tags / segmentacao de pacientes
    PatientTagsModule,
    // Fase 21 — Indicacao Premiada (cashback)
    ReferralsModule,
    // Marketing — Influenciadores
    InfluencersModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // JwtAuthGuard deve vir ANTES de RolesGuard para popular req.user antes da checagem de roles
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
