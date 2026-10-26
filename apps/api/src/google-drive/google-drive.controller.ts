import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  Res,
  Request,
  UseGuards,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { GoogleDriveService } from './google-drive.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { encryptValue, isSensitiveKey } from '../common/utils/crypto.util';
import { assinarEstadoOAuth, verificarEstadoOAuth } from './oauth-state';

/**
 * O Google Drive é uma integração da PLATAFORMA (uma pasta raiz e uma conta Google
 * para todas as contas): configurar, conectar, testar e o papel timbrado são só do
 * SUPER_ADMIN. As pastas dos leads são dado da clínica: só a própria conta alcança.
 */
function ehSuperAdmin(req: any): boolean {
  return Array.isArray(req?.user?.roles) && req.user.roles.includes('SUPER_ADMIN');
}

/** Lead com conta diferente da do usuário (SUPER_ADMIN e lead legado sem conta passam). */
function leadDeOutraConta(leadTenantId: string | null | undefined, req: any): boolean {
  if (ehSuperAdmin(req)) return false;
  return !!leadTenantId && leadTenantId !== req?.user?.tenant_id;
}

@UseGuards(JwtAuthGuard)
@Controller('google-drive')
export class GoogleDriveController {
  private readonly logger = new Logger(GoogleDriveController.name);

  constructor(
    private readonly driveService: GoogleDriveService,
    private readonly prisma: PrismaService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  //  Config — Service Account + Root Folder
  // ═══════════════════════════════════════════════════════════════

  /**
   * GET /google-drive/config — status da configuração (acessível a todos autenticados).
   * A integração é da PLATAFORMA (um Drive só): quem não é SUPER_ADMIN recebe o mesmo
   * formato, só com os "sim/não" — sem id de pasta, de timbrado nem e-mail da conta Google.
   */
  @Get('config')
  async getConfig(@Request() req: any) {
    const cfg = await this.driveService.getConfig();
    if (ehSuperAdmin(req)) return cfg;
    return {
      ...cfg,
      rootFolderId: null,
      oauthUserEmail: null,
      letterheadTemplateId: null,
      letterheadTemplateName: null,
    };
  }

  /** POST /google-drive/config — salvar service account + root folder */
  @Post('config')
  @Roles('SUPER_ADMIN')
  async saveConfig(
    @Body() body: { serviceAccountJson?: string; rootFolderId?: string },
  ) {
    if (body.serviceAccountJson) {
      try {
        const parsed = JSON.parse(body.serviceAccountJson);
        if (!parsed.client_email || !parsed.private_key) {
          throw new BadRequestException(
            'JSON da service account deve conter client_email e private_key',
          );
        }
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException('JSON da service account inválido');
      }

      const b64 = Buffer.from(body.serviceAccountJson).toString('base64');
      const encryptedValue = isSensitiveKey('GDRIVE_SERVICE_ACCOUNT_B64')
        ? encryptValue(b64)
        : b64;

      await this.prisma.globalSetting.upsert({
        where: { key: 'GDRIVE_SERVICE_ACCOUNT_B64' },
        update: { value: encryptedValue },
        create: { key: 'GDRIVE_SERVICE_ACCOUNT_B64', value: encryptedValue },
      });
    }

    if (body.rootFolderId) {
      await this.prisma.globalSetting.upsert({
        where: { key: 'GDRIVE_ROOT_FOLDER_ID' },
        update: { value: body.rootFolderId },
        create: { key: 'GDRIVE_ROOT_FOLDER_ID', value: body.rootFolderId },
      });
    }

    return this.driveService.getConfig();
  }

  /** POST /google-drive/test — testar conexão */
  @Post('test')
  @Roles('SUPER_ADMIN')
  testConnection() {
    return this.driveService.testConnection();
  }

  // ═══════════════════════════════════════════════════════════════
  //  OAuth2 — Fluxo de autorização (como o n8n faz)
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST /google-drive/oauth/config — salvar Client ID e Secret do OAuth2
   * O admin precisa criar credenciais OAuth2 no Google Cloud Console.
   */
  @Post('oauth/config')
  @Roles('SUPER_ADMIN')
  async saveOAuthConfig(
    @Body() body: { clientId: string; clientSecret: string; redirectUri?: string },
  ) {
    if (!body.clientId || !body.clientSecret) {
      throw new BadRequestException('clientId e clientSecret são obrigatórios');
    }

    // Salvar Client ID (criptografado)
    const encClientId = isSensitiveKey('GDRIVE_OAUTH_CLIENT_ID')
      ? encryptValue(body.clientId)
      : body.clientId;
    await this.prisma.globalSetting.upsert({
      where: { key: 'GDRIVE_OAUTH_CLIENT_ID' },
      update: { value: encClientId },
      create: { key: 'GDRIVE_OAUTH_CLIENT_ID', value: encClientId },
    });

    // Salvar Client Secret (criptografado)
    const encSecret = isSensitiveKey('GDRIVE_OAUTH_CLIENT_SECRET')
      ? encryptValue(body.clientSecret)
      : body.clientSecret;
    await this.prisma.globalSetting.upsert({
      where: { key: 'GDRIVE_OAUTH_CLIENT_SECRET' },
      update: { value: encSecret },
      create: { key: 'GDRIVE_OAUTH_CLIENT_SECRET', value: encSecret },
    });

    // Salvar Redirect URI (opcional)
    if (body.redirectUri) {
      await this.prisma.globalSetting.upsert({
        where: { key: 'GDRIVE_OAUTH_REDIRECT_URI' },
        update: { value: body.redirectUri },
        create: { key: 'GDRIVE_OAUTH_REDIRECT_URI', value: body.redirectUri },
      });
    }

    this.logger.log('Configuração OAuth2 salva');
    return { ok: true, message: 'Configuração OAuth2 salva com sucesso' };
  }

  /**
   * GET /google-drive/oauth/url — gera URL de autorização do Google.
   * O admin será redirecionado para essa URL para conectar sua conta.
   */
  @Get('oauth/url')
  @Roles('SUPER_ADMIN')
  async getOAuthUrl(@Request() req: any) {
    let state: string;
    try {
      state = assinarEstadoOAuth(String(req.user?.id || ''));
    } catch (err: any) {
      throw new BadRequestException(err?.message || 'Não foi possível iniciar a conexão com o Google');
    }
    const url = await this.driveService.getOAuthUrl(state);
    return { url };
  }

  /**
   * GET /google-drive/oauth/callback — callback do Google após autorização.
   * Recebe o code, troca por refresh_token, e redireciona pro frontend.
   */
  @Public()
  @Get('oauth/callback')
  async handleOAuthCallback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL
      || process.env.NEXT_PUBLIC_API_URL?.replace('/api', '')
      || 'https://sistema.institutoodontopassos.com.br';

    const settingsPath = '/atendimento/settings/google-drive';

    if (error) {
      this.logger.warn(`OAuth2 callback error: ${error}`);
      res.redirect(`${frontendUrl}${settingsPath}?oauth=error&message=${encodeURIComponent(error)}`);
      return;
    }

    if (!code) {
      res.redirect(`${frontendUrl}${settingsPath}?oauth=error&message=${encodeURIComponent('Código de autorização ausente')}`);
      return;
    }

    // Rota pública: só troca a conta Google da plataforma se o retorno vier de um
    // fluxo aberto há menos de 15 min por quem ainda é SUPER_ADMIN.
    if (!(await this.estadoOAuthValido(state))) {
      this.logger.warn('OAuth2 callback recusado: state ausente, inválido ou vencido');
      res.redirect(`${frontendUrl}${settingsPath}?oauth=error&message=${encodeURIComponent('Retorno do Google não confere ou expirou. Clique em "Conectar com Google" de novo.')}`);
      return;
    }

    try {
      const { email } = await this.driveService.handleOAuthCallback(code);
      res.redirect(`${frontendUrl}${settingsPath}?oauth=success&email=${encodeURIComponent(email)}`);
    } catch (err: any) {
      this.logger.error(`OAuth2 callback falhou: ${err.message}`);
      res.redirect(`${frontendUrl}${settingsPath}?oauth=error&message=${encodeURIComponent(err.message)}`);
    }
  }

  /**
   * POST /google-drive/oauth/disconnect — desconectar OAuth2.
   */
  @Post('oauth/disconnect')
  @Roles('SUPER_ADMIN')
  async disconnectOAuth() {
    await this.driveService.disconnectOAuth();
    return { ok: true, message: 'OAuth2 desconectado' };
  }

  /** state assinado, no prazo, e o usuário que abriu o fluxo ainda é SUPER_ADMIN. */
  private async estadoOAuthValido(state: unknown): Promise<boolean> {
    const userId = verificarEstadoOAuth(state);
    if (!userId) return false;
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });
      return Array.isArray(user?.roles) && user!.roles.includes('SUPER_ADMIN');
    } catch (err: any) {
      this.logger.warn(`OAuth2 callback: falha ao conferir o usuário do state: ${err?.message}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Papel Timbrado (Letterhead Template)
  // ═══════════════════════════════════════════════════════════════

  /**
   * GET /google-drive/leads/:leadId/files — lista arquivos da pasta do Drive do lead.
   */
  @Get('leads/:leadId/files')
  async listLeadFiles(@Param('leadId') leadId: string, @Request() req: any) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { google_drive_folder_id: true, tenant_id: true },
    });
    // Lead de OUTRA conta: 404, sem tocar no Drive (lead legado sem conta segue igual).
    if (lead && leadDeOutraConta(lead.tenant_id, req)) {
      throw new NotFoundException('Lead não encontrado');
    }
    if (!lead?.google_drive_folder_id) {
      return [];
    }
    try {
      return await this.driveService.listFolderFiles(lead.google_drive_folder_id);
    } catch (e: any) {
      this.logger.warn(`[DRIVE] Erro ao listar arquivos do lead ${leadId}: ${e.message}`);
      return [];
    }
  }

  /**
   * GET /google-drive/letterhead — status do papel timbrado configurado.
   */
  @Get('letterhead')
  @Roles('SUPER_ADMIN')
  async getLetterhead() {
    return this.driveService.getLetterheadInfo();
  }

  /**
   * POST /google-drive/letterhead/search — buscar arquivos no Drive do usuário.
   * Usado para encontrar o papel timbrado.
   */
  @Post('letterhead/search')
  @Roles('SUPER_ADMIN')
  async searchFiles(@Body() body: { query: string }) {
    if (!body.query?.trim()) {
      throw new BadRequestException('Query de busca é obrigatória');
    }
    const files = await this.driveService.searchDriveFiles(body.query.trim());
    return { files };
  }

  /**
   * POST /google-drive/letterhead — definir um arquivo como papel timbrado.
   * Se o arquivo é DOCX, converte automaticamente para Google Doc.
   */
  @Post('letterhead')
  @Roles('SUPER_ADMIN')
  async setLetterhead(@Body() body: { fileId: string }) {
    if (!body.fileId?.trim()) {
      throw new BadRequestException('fileId é obrigatório');
    }
    try {
      const result = await this.driveService.setLetterheadTemplate(body.fileId.trim());
      return {
        ok: true,
        message: 'Papel timbrado configurado com sucesso',
        ...result,
      };
    } catch (err: any) {
      this.logger.error(`Erro ao configurar papel timbrado: ${err.message}`);
      throw new BadRequestException(err.message);
    }
  }

  /**
   * DELETE /google-drive/letterhead — remover papel timbrado.
   */
  @Delete('letterhead')
  @Roles('SUPER_ADMIN')
  async removeLetterhead() {
    await this.driveService.removeLetterhead();
    return { ok: true, message: 'Papel timbrado removido' };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Pastas de Lead — criação manual
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST /google-drive/leads/:leadId/folder
   * Cria (ou retorna) a pasta do lead no Drive.
   * Qualquer usuário autenticado pode acionar.
   */
  @Post('leads/:leadId/folder')
  async createLeadFolder(@Param('leadId') leadId: string, @Request() req: any) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { name: true, tenant_id: true },
    });
    // Lead de OUTRA conta: mesmo 404 do lead inexistente (lead legado sem conta segue igual).
    if (!lead || leadDeOutraConta(lead.tenant_id, req)) throw new NotFoundException('Lead não encontrado');

    const configured = await this.driveService.isConfigured();
    if (!configured) {
      throw new BadRequestException('Google Drive não configurado. Peça ao administrador do sistema para configurar a integração.');
    }

    const folderId = await this.driveService.ensureLeadFolder(leadId, lead.name || 'Lead');
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
    return { ok: true, folderId, folderUrl };
  }
}
