import { Injectable, Logger, NotFoundException, BadRequestException, UnauthorizedException, GoneException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { evolutionSendFailed } from '../whatsapp/whatsapp.service';
import { escolherChipPaciente, chipPacienteOuLegado, soTemChipFinanceiro, isLabTenant } from '@crm/shared';
import { negarLaboratorio } from '../common/lab-gate.util';

@Injectable()
export class PortalAuthService {
  private readonly logger = new Logger(PortalAuthService.name);
  private readonly TOKEN_TTL_DAYS = 7;
  // JWT que paciente carrega depois de trocar o magic link
  private readonly SESSION_TTL = '30d';

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private settings: SettingsService,
  ) {}

  /**
   * Recepcao chama com tenantId+patientId+(opcional) channel.
   * Gera token aleatorio, salva e — se canal=WHATSAPP e Evolution
   * configurada — dispara mensagem com o link automaticamente.
   *
   * Retorna token + url + status do envio (para feedback na UI).
   */
  async createMagicLink(
    tenantId: string,
    patientId: string,
    channel: string = 'WHATSAPP',
    purpose: 'GENERIC' | 'ANAMNESE' = 'GENERIC',
  ) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
      select: { id: true, name: true, phone: true, email: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    // F2 [LAB-GATE] — portal do paciente (agenda, parcelas, ficha de anamnese) é de
    // clínica: conta de laboratório recusa o link. O paciente foi achado NESTA conta,
    // então ela é a conta do registro. Clínica: só a leitura cacheada.
    if (await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m))) {
      throw negarLaboratorio('Portal do paciente (link de acesso)');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.TOKEN_TTL_DAYS);

    const created = await this.prisma.portalToken.create({
      data: {
        tenant_id: tenantId,
        patient_id: patientId,
        token,
        expires_at: expiresAt,
        channel,
      },
    });

    // Monta URL completa do magic link
    const publicUrl =
      process.env.PORTAL_PUBLIC_URL ||
      process.env.PUBLIC_WEB_URL ||
      'https://sistema.institutoodontopassos.com.br';
    // ?next=... e lido pelo /area-paciente/login para redirecionar apos auth
    const nextPath = purpose === 'ANAMNESE' ? '/area-paciente/anamnese/preencher' : '';
    const nextParam = nextPath ? `&next=${encodeURIComponent(nextPath)}` : '';
    const link = `${publicUrl.replace(/\/+$/, '')}/area-paciente/login?token=${created.token}${nextParam}`;

    // Auto-dispatch via WhatsApp (best-effort)
    let dispatch: { status: 'SENT' | 'SKIPPED' | 'FAILED'; reason?: string } = {
      status: 'SKIPPED',
    };

    if (channel === 'WHATSAPP' && patient.phone) {
      dispatch = await this.dispatchWhatsApp(tenantId, patient.phone, patient.name, link, purpose);
    } else if (channel === 'WHATSAPP' && !patient.phone) {
      dispatch = { status: 'SKIPPED', reason: 'Paciente sem telefone' };
    }

    return {
      token: created.token,
      expires_at: created.expires_at,
      link,
      purpose,
      patient: {
        id: patient.id,
        name: patient.name,
        phone: patient.phone,
        email: patient.email,
      },
      dispatch,
    };
  }

  /**
   * Normaliza telefone pro formato internacional sem '+' que a Evolution
   * exige (55 + DDD + numero). Onda 17.12.
   *
   *  - "82998578143"         -> "5582998578143"   (sem 55, com 9)
   *  - "8298578143"          -> "558298578143"    (sem 55, fixo)
   *  - "5582998578143"       -> "5582998578143"   (ja com 55)
   *  - "+55 (82) 99857-8143" -> "5582998578143"   (com mascara/+)
   *
   * Retorna null se o numero nao bate em nenhum formato BR.
   */
  private normalizeBRPhone(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 13 && digits.startsWith('55')) return digits;
    if (digits.length === 12 && digits.startsWith('55')) return digits;
    if (digits.length === 11) return `55${digits}`;
    if (digits.length === 10) return `55${digits}`;
    return null;
  }

  /**
   * Dispara mensagem WhatsApp via Evolution. Resolve instance do tenant
   * (primeira ativa). Best-effort: nunca derruba o fluxo de criacao do
   * token — falhas viram dispatch.status=FAILED.
   */
  private async dispatchWhatsApp(
    tenantId: string,
    phone: string,
    name: string,
    link: string,
    purpose: 'GENERIC' | 'ANAMNESE' = 'GENERIC',
  ): Promise<{ status: 'SENT' | 'FAILED'; reason?: string }> {
    // Onda 17.12 — Normaliza telefone ANTES de chamar Evolution.
    // Evolution exige formato internacional (55+DDD+numero). Quando o
    // cadastro tem so "82998578143" (sem 55), a Evolution rejeita com
    // 400 Bad Request. Esta foi a causa raiz do "Bad Request" reportado
    // — o cadastro estava certo, so faltava o 55 na hora de enviar.
    const normalizedPhone = this.normalizeBRPhone(phone);
    if (!normalizedPhone) {
      this.logger.warn(`[Portal] [evolution-skip] Telefone invalido: "${phone}"`);
      return {
        status: 'FAILED',
        reason: `Telefone "${phone}" sem formato BR valido. Edite o cadastro do paciente.`,
      };
    }
    if (normalizedPhone !== phone) {
      this.logger.log(`[Portal] [phone-normalize] "${phone}" -> "${normalizedPhone}"`);
    }

    try {
      const cfg = await this.settings.getWhatsAppConfig();
      if (!cfg.apiUrl || !cfg.apiKey) {
        return { status: 'FAILED', reason: 'Evolution API nao configurada' };
      }
      // Link do portal/anamnese é do PACIENTE ⇒ chip CLINICA (na falta, o COMERCIAL),
      // nunca o FINANCEIRO. Antes era a 1ª Instance por NOME — 'Comercial'/'whatsapp'
      // (órfãs, purpose NULL) vinham antes de 't00000000-*' e o envio ia pra elas.
      // Clínica legada (sem chip com função) segue no 1º chip por nome, sem o financeiro.
      const chips = await this.prisma.instance.findMany({
        where: { tenant_id: tenantId, type: 'whatsapp' },
        select: { name: true, purpose: true },
        orderBy: { name: 'asc' },
      });
      const escolha = escolherChipPaciente(chips, 'CLINICA');
      const instanceName = chipPacienteOuLegado(escolha);
      if (!instanceName) {
        return {
          status: 'FAILED',
          reason: soTemChipFinanceiro(escolha)
            ? 'A clínica só tem o chip do Financeiro conectado — o link não sai por ele. Conecte o WhatsApp da Clínica.'
            : 'Sem Evolution instance no tenant',
        };
      }
      const instance = { name: instanceName };

      const firstName = name.split(' ')[0];
      const text = purpose === 'ANAMNESE'
        ? (
          `Ola ${firstName}! 👋\n\n` +
          `Para sua proxima consulta na nossa clinica, precisamos que voce ` +
          `preencha sua *ficha de anamnese* (historico de saude).\n\n` +
          `Acesse o link abaixo, responda as perguntas e confirme com seu ` +
          `nome ao final. Leva so uns 3 minutos:\n\n` +
          `${link}\n\n` +
          `🔒 Link pessoal, valido por 7 dias.`
        )
        : (
          `Ola ${firstName}! 👋\n\n` +
          `Seu portal do paciente esta pronto. Acesse para ver:\n` +
          `📅 Agendamentos\n` +
          `💰 Parcelas\n` +
          `📋 Anamnese\n\n` +
          `${link}\n\n` +
          `Link valido por 7 dias e de uso unico.`
        );

      const endpoint = `${cfg.apiUrl}/message/sendText/${instance.name}`;
      this.logger.log(
        `[Portal] [evolution-call] POST ${endpoint} | phone=${normalizedPhone} | instance=${instance.name}`,
      );
      // Envia o número NORMALIZADO (com 55) — o cru ia sem DDI e a Evolution recusava.
      const resp = await axios.post(
        endpoint,
        { number: normalizedPhone, text },
        {
          headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
          timeout: 15000,
        },
      );
      // 2xx com exists:false = número sem WhatsApp → FALHA, não "enviado".
      if (evolutionSendFailed(resp?.data)) {
        this.logger.warn(`[Portal] [evolution-FAILED] phone=${normalizedPhone} | instance=${instance.name} | número sem WhatsApp`);
        return { status: 'FAILED', reason: 'Esse número não tem WhatsApp. Confira o telefone no cadastro do paciente.' };
      }
      this.logger.log(`[Portal] Magic link (${purpose}) enviado para ${name} (${phone})`);
      return { status: 'SENT' };
    } catch (err: any) {
      // Onda 17.10 — log MUITO mais detalhado pra diagnose. Antes so
      // mostrava o message generico ("fetch failed"). Agora inclui:
      // - URL exata que tentou chamar
      // - Status code se a Evolution respondeu
      // - Body de erro da Evolution
      // - error code (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, etc) — esses
      //   sao os mais uteis pra distinguir DNS x rede x firewall.
      const status = err?.response?.status;
      const body = err?.response?.data;
      const code = err?.code || err?.cause?.code;
      const reason =
        body?.message ||
        body?.error ||
        err?.message ||
        'erro desconhecido';

      this.logger.error(
        `[Portal] [evolution-FAILED] phone=${phone} | ` +
        `code=${code || 'n/a'} | http=${status || 'sem-resposta'} | ` +
        `reason="${reason}" | body=${body ? JSON.stringify(body).slice(0, 200) : 'n/a'}`,
      );

      // Mensagem amigavel pro frontend, com dica baseada no tipo de erro.
      let humanReason = reason;
      if (code === 'ENOTFOUND') humanReason = 'Evolution API: endereço não resolvido (DNS). Verifique a URL em Configurações.';
      else if (code === 'ECONNREFUSED') humanReason = 'Evolution API: conexão recusada. Verifique se a API está online.';
      else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') humanReason = 'Evolution API: timeout (15s). API pode estar lenta.';
      else if (status === 401 || status === 403) humanReason = 'Evolution API: apikey inválida ou não autorizada.';
      else if (status === 404) humanReason = 'Evolution API: instance não encontrada. Verifique o nome da instância.';
      else if (reason === 'fetch failed') humanReason = 'Evolution API inacessível (fetch failed). Container do API não conseguiu alcançar a URL configurada.';

      return { status: 'FAILED', reason: humanReason };
    }
  }

  /**
   * Valida token (publico, sem auth) e troca por JWT do paciente.
   * Marca token como consumido — nao pode ser reusado.
   */
  async exchangeToken(token: string, ip?: string, userAgent?: string) {
    if (!token || token.length < 10) {
      throw new BadRequestException('Token invalido');
    }

    const row = await this.prisma.portalToken.findUnique({
      where: { token },
      include: {
        patient: { select: { id: true, name: true, tenant_id: true, status: true } },
      },
    });
    if (!row) throw new UnauthorizedException('Token nao encontrado');
    if (row.consumed_at) throw new GoneException('Token ja foi usado — solicite novo link');
    if (row.expires_at < new Date()) throw new GoneException('Token expirado — solicite novo link');
    if (row.patient.status === 'ARCHIVED') {
      throw new UnauthorizedException('Paciente arquivado');
    }
    // F2 [LAB-GATE] — backstop: link emitido antes da conta virar laboratório não abre o
    // portal (nem é consumido). Clínica: só a leitura cacheada.
    if (await isLabTenant(this.prisma, row.patient.tenant_id, (m) => this.logger.warn(m))) {
      throw negarLaboratorio('Portal do paciente');
    }

    // Marca consumido + grava metadata
    await this.prisma.portalToken.update({
      where: { id: row.id },
      data: {
        consumed_at: new Date(),
        ip_address: ip,
        user_agent: userAgent?.slice(0, 200),
      },
    });

    const jwt = await this.jwt.signAsync(
      {
        sub: row.patient.id,
        kind: 'patient',
        patient_id: row.patient.id,
        tenant_id: row.patient.tenant_id,
      },
      { expiresIn: this.SESSION_TTL },
    );

    return {
      jwt,
      patient: { id: row.patient.id, name: row.patient.name },
    };
  }
}
