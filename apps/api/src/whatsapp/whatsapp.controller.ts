import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request, Logger, ForbiddenException } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SettingsService } from '../settings/settings.service';

@Controller('whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly settingsService: SettingsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // Onda 17.32.130 — Endpoints "Conectar via QR" pro tenant
  //
  // ADMIN da clinica nao precisa saber nada de Evolution. Clica
  // "Conectar WhatsApp" -> backend cuida do resto.
  // ═══════════════════════════════════════════════════════════════════

  /** Lista os WhatsApps DESSE tenant. */
  @Get('my-numbers')
  async myNumbers(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant no token');
    return this.whatsappService.listForTenant(tenantId);
  }

  /** Conecta um novo WhatsApp — cria instancia + retorna QR. */
  @Post('my-numbers/connect')
  async connectMyNumber(
    @Request() req: any,
    @Body() body: { displayName?: string },
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant no token');
    return this.whatsappService.quickConnect(tenantId, body?.displayName);
  }

  /** Reconecta uma linha existente (gera novo QR — se cair, reescaneia). */
  @Post('my-numbers/:name/reconnect')
  async reconnectMyNumber(@Request() req: any, @Param('name') name: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant no token');
    return this.whatsappService.reconnectForTenant(tenantId, name);
  }

  /** Deleta uma linha do tenant (com validacao de ownership). */
  @Delete('my-numbers/:name')
  async deleteMyNumber(@Request() req: any, @Param('name') name: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant no token');
    return this.whatsappService.deleteForTenant(tenantId, name);
  }

  /** Renomeia o apelido da linha (so display_name; nao mexe na Evolution). */
  @Patch('my-numbers/:name')
  async renameMyNumber(
    @Request() req: any,
    @Param('name') name: string,
    @Body() body: { displayName: string },
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Sem tenant no token');
    return this.whatsappService.renameForTenant(tenantId, name, body?.displayName);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Endpoints legacy — mantidos pra compat. Os novos clientes (ADMIN
  // de tenant) usam /my-numbers acima.
  // ═══════════════════════════════════════════════════════════════════

  @Get('instances')
  async listInstances() {
    return this.whatsappService.listInstances();
  }

  @Post('instances')
  async createInstance(@Body('name') name: string) {
    const instance = await this.whatsappService.createInstance(name);
    
    // Autoconfigura o webhook assim que a instância é criada
    try {
      const config = await this.settingsService.getWhatsAppConfig();
      if (config.webhookUrl) {
        await this.whatsappService.setWebhook(name, config.webhookUrl);
        this.logger.log(`Webhook configurado automaticamente para instância: ${name}`);
      }
    } catch (e) {
      this.logger.error(`Falha ao configurar webhook automático para ${name}:`, e);
    }

    return instance;
  }

  @Delete('instances/:name')
  async deleteInstance(@Param('name') name: string) {
    return this.whatsappService.deleteInstance(name);
  }

  @Post('instances/:name/logout')
  async logoutInstance(@Param('name') name: string) {
    return this.whatsappService.logoutInstance(name);
  }

  @Get('instances/:name/connect')
  async getConnectCode(@Param('name') name: string) {
    return this.whatsappService.getConnectCode(name);
  }

  @Get('instances/:name/status')
  async getConnectionStatus(@Param('name') name: string) {
    return this.whatsappService.getConnectionStatus(name);
  }

  @Get('instances/:name/contacts')
  async fetchContacts(@Param('name') name: string) {
    return this.whatsappService.fetchContacts(name);
  }

  @Post('instances/:name/sync')
  async syncContacts(@Param('name') name: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    return this.whatsappService.syncContacts(name, tenantId);
  }

  @Post('instances/:name/settings')
  async setInstanceSettings(
    @Param('name') name: string,
    @Body() body: { rejectCall?: boolean; msgCall?: string; alwaysOnline?: boolean },
  ) {
    return this.whatsappService.setInstanceSettings(name, body);
  }
}
