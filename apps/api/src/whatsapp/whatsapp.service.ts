import { Injectable, Logger, Inject, forwardRef, BadRequestException } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { toBrazilWhatsappNumber } from '@crm/shared';
import * as crypto from 'crypto';

// Onda 17.61 — fallback do 9º dígito do celular BR. Vários DDDs (ex.: 82/Nordeste)
// têm o número registrado no WhatsApp SEM o 9 extra, mas o sistema às vezes guarda
// COM (ou vice-versa) — aí o envio falha. Estes helpers geram a variante alternada
// e detectam a falha pra tentar de novo automaticamente.
function toggleBr9thDigit(num: string): string | null {
  const d = (num || '').replace(/\D/g, '');
  if (!d.startsWith('55')) return null;
  const rest = d.slice(2); // DDD + número local
  if (rest.length < 10) return null;
  const ddd = rest.slice(0, 2);
  const local = rest.slice(2);
  if (local.length === 9 && local[0] === '9') return `55${ddd}${local.slice(1)}`; // tira o 9
  if (local.length === 8) return `55${ddd}9${local}`; // põe o 9
  return null;
}

function evolutionSendFailed(res: any): boolean {
  if (!res) return true;
  if (res.statusCode >= 400 || res.error) return true;
  // Evolution responde exists:false quando o número não está no WhatsApp.
  try { if (/"exists"\s*:\s*false/.test(JSON.stringify(res))) return true; } catch { /* ignore */ }
  return false;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  
  constructor(
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => LeadsService)) private readonly leadsService: LeadsService,
    private readonly prisma: PrismaService,
  ) {}

  private normalizeUrl(url: string): string {
    if (!url) return '';
    let normalized = url.trim().replace(/\/+$/, ''); // Remove barras no final
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    return normalized;
  }

  /**
   * Onda 17.32.84 — Resolve qual instance/key/baseUrl da Evolution usar.
   * Ordem de precedencia:
   *   1. TenantSetting{tenant_id, key} — config do tenant
   *   2. GlobalSetting (via WhatsAppConfig) — fallback compartilhado
   *   3. env vars EVOLUTION_INSTANCE_NAME, EVOLUTION_API_KEY, EVOLUTION_BASE_URL
   *   4. Default 'whatsapp'
   */
  async resolveEvolutionConfig(tenantId?: string | null): Promise<{
    apiUrl: string;
    apiKey: string;
    instanceName: string;
  }> {
    const { getTenantSetting } = await import('../tenants/tenant-settings.helper.js');
    const tInst = await getTenantSetting(this.prisma, 'EVOLUTION_INSTANCE_NAME', tenantId, 'EVOLUTION_INSTANCE_NAME');
    const tKey  = await getTenantSetting(this.prisma, 'EVOLUTION_API_KEY',       tenantId, 'EVOLUTION_API_KEY');
    const tUrl  = await getTenantSetting(this.prisma, 'EVOLUTION_BASE_URL',      tenantId, 'EVOLUTION_BASE_URL');

    // Fallback pra GlobalSetting via SettingsService quando tenant nao tem
    let apiUrl = tUrl;
    let apiKey = tKey;
    if (!apiUrl || !apiKey) {
      const global = await this.settingsService.getWhatsAppConfig();
      apiUrl = apiUrl || global.apiUrl || '';
      apiKey = apiKey || global.apiKey || '';
    }
    return {
      apiUrl: apiUrl || '',
      apiKey: apiKey || '',
      instanceName: tInst || 'whatsapp',
    };
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: any,
    timeoutMs = 15000,
    tenantId?: string | null,
  ) {
    // Onda 17.32.84 — Quando tenantId passado, usa config DO TENANT.
    // Senao, mantem comportamento legacy (config global compartilhada).
    let baseUrl: string;
    let apiKey: string;
    if (tenantId) {
      const cfg = await this.resolveEvolutionConfig(tenantId);
      baseUrl = this.normalizeUrl(cfg.apiUrl);
      apiKey = cfg.apiKey;
    } else {
      const config = await this.settingsService.getWhatsAppConfig();
      baseUrl = this.normalizeUrl(config.apiUrl || '');
      apiKey = config.apiKey || '';
    }
    const url = `${baseUrl}/${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          apikey: apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Erro Evolution API (${path}) - Status: ${response.status} - Resposta: ${errorText}`,
        );
        return { statusCode: response.status, error: errorText };
      }

      return await response.json();
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        this.logger.error(`Timeout na requisição Evolution API (${path}) após ${timeoutMs}ms`);
        return { statusCode: 408, error: `Request timeout after ${timeoutMs}ms` };
      }
      this.logger.error(`Exceção na requisição Evolution API (${path}): ${e}`);
      throw e;
    }
  }

  // --- MENSAGENS ---

  /**
   * Onda 17.32.84 — Aceita tenantId opcional. Quando passado, usa
   * a instancia Evolution DO TENANT (TenantSetting{EVOLUTION_INSTANCE_NAME}).
   * Sem tenantId, mantem comportamento legacy.
   */
  async sendText(number: string, text: string, instanceName?: string, quoted?: { key: { remoteJid: string; fromMe: boolean; id: string }; message: { conversation: string } }, tenantId?: string | null) {
    let targetInstance = instanceName;
    if (!targetInstance) {
      if (tenantId) {
        const cfg = await this.resolveEvolutionConfig(tenantId);
        targetInstance = cfg.instanceName;
      } else {
        targetInstance = process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
      }
    }
    // Onda 17.56 — garante o codigo do pais (55) pra numero BR salvo sem DDI.
    // Cirurgico/idempotente: JID e numero ja-com-DDI passam intactos.
    const primary = toBrazilWhatsappNumber(number);
    const doSend = (num: string) => {
      const payload: any = { number: num, text };
      if (quoted) payload.quoted = quoted;
      return this.request('POST', `message/sendText/${targetInstance}`, payload, 15000, tenantId);
    };

    // Onda 17.62 — 9º dígito BR: descobre qual variante (com/sem o 9) EXISTE no WhatsApp e
    // manda 1 vez só NELA. Resolve o caso do número cadastrado num formato e o WhatsApp da
    // pessoa registrado no outro (ex.: cadastro com o 9, mas o WhatsApp dela é sem o 9) —
    // entrega no número REAL, sem duplicar e sem chutar. Se o check não responder, envia no
    // cadastrado (sem retry, pra não arriscar disparo pro número errado). JID (@) passa direto.
    if (!primary.includes('@')) {
      const alt = toggleBr9thDigit(primary);
      if (alt && alt !== primary) {
        const existing = await this.firstExistingNumber([primary, alt], targetInstance, tenantId);
        if (existing) return doSend(existing);
      }
    }
    return doSend(primary);
  }

  /**
   * Onda 17.62 — qual dos números EXISTE no WhatsApp (Evolution /chat/whatsappNumbers),
   * preferindo o 1º (cadastrado). Retorna null se o check estiver indisponível — aí o
   * chamador envia no cadastrado. Entrega no número REAL (com OU sem o 9) e manda 1x só,
   * em vez de enviar+reenviar (que gerava 2 disparos).
   */
  private async firstExistingNumber(numbers: string[], instance: string, tenantId?: string | null): Promise<string | null> {
    try {
      const res: any = await this.request('POST', `chat/whatsappNumbers/${instance}`, { numbers }, 10000, tenantId);
      const arr = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : null;
      if (!arr || arr.length === 0) return null;
      const digits = (s: any) => String(s || '').replace(/\D/g, '');
      for (const n of numbers) {
        const dn = digits(n);
        const hit = arr.find((r: any) => r && r.exists === true && (digits(r.number) === dn || digits(r.jid) === dn));
        if (hit) return n;
      }
      return null;
    } catch {
      return null;
    }
  }

  async deleteForEveryone(instanceName: string, remoteJid: string, externalMessageId: string, fromMe: boolean) {
    const targetInstance = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
    return this.request('DELETE', `chat/deleteMessageForEveryone/${targetInstance}`, {
      id: externalMessageId,
      remoteJid,
      fromMe,
    });
  }

  async editMessage(instanceName: string, number: string, externalMessageId: string, newText: string) {
    const targetInstance = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
    const remoteJid = `${number}@s.whatsapp.net`;
    return this.request('POST', `chat/updateMessage/${targetInstance}`, {
      number,
      text: newText,
      key: {
        id: externalMessageId,
        fromMe: true,
        remoteJid,
      },
    });
  }

  async sendMedia(
    number: string,
    mediaType: 'image' | 'audio' | 'document' | 'video',
    mediaUrl: string,
    caption?: string,
    instanceName?: string,
    fileName?: string,
    /** Onda 14.42 — mimetype opcional, necessario quando mediaUrl e base64
     *  puro (sem prefixo data:...). Evolution precisa saber o tipo MIME
     *  pra processar o arquivo. Default: deduz por mediaType. */
    mimetype?: string,
  ) {
    const targetInstance = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';

    // 9º dígito BR: resolve a variante (com/sem o 9) que EXISTE no WhatsApp, igual
    // ao sendText (Onda 17.62). Sem isso, mídia/documento (ex.: boleto em PDF) ia
    // pro número CRU e falhava/entregava errado onde o cadastro diverge do WhatsApp
    // real (comum em DDDs do Nordeste, ex.: 82). JID (@) e não-BR passam direto.
    const primaryNum = toBrazilWhatsappNumber(number);
    let target = primaryNum;
    if (!primaryNum.includes('@')) {
      const alt = toggleBr9thDigit(primaryNum);
      if (alt && alt !== primaryNum) {
        const existing = await this.firstExistingNumber([primaryNum, alt], targetInstance);
        if (existing) target = existing;
      }
    }

    if (mediaType === 'audio') {
      return this.request('POST', `message/sendWhatsAppAudio/${targetInstance}`, {
        number: target,
        audio: mediaUrl,
      });
    }

    // Onda 14.42 — Auto-detecta mimetype baseado em mediaType + extensao
    // do fileName, se nao fornecido explicitamente.
    const resolvedMimetype = mimetype || (
      mediaType === 'image' ? 'image/jpeg' :
      mediaType === 'video' ? 'video/mp4' :
      mediaType === 'document' && fileName?.endsWith('.pdf') ? 'application/pdf' :
      mediaType === 'document' ? 'application/octet-stream' :
      undefined
    );

    return this.request('POST', `message/sendMedia/${targetInstance}`, {
      number: target,
      mediatype: mediaType,
      media: mediaUrl,
      caption: caption || '',
      ...(fileName ? { fileName } : {}),
      ...(resolvedMimetype ? { mimetype: resolvedMimetype } : {}),
    });
  }

  // --- MENSAGENS INTERATIVAS ---

  async sendList(
    number: string,
    title: string,
    description: string,
    buttonText: string,
    sections: { title: string; rows: { title: string; description?: string; rowId: string }[] }[],
    instanceName?: string,
    footerText?: string,
  ) {
    const targetInstance = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
    return this.request('POST', `message/sendList/${targetInstance}`, {
      number: toBrazilWhatsappNumber(number),
      title,
      description,
      buttonText,
      footerText: footerText || '',
      sections,
    });
  }

  // --- REAÇÕES ---

  async sendReaction(instanceName: string, key: { remoteJid: string; fromMe: boolean; id: string }, emoji: string) {
    const inst = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
    return this.request('POST', `message/sendReaction/${inst}`, { key, reaction: emoji });
  }

  // --- PRESENÇA & LEITURA ---

  async markAsRead(instanceName: string, readMessages: { remoteJid: string; fromMe: false; id: string }[]) {
    const inst = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
    return this.request('POST', `chat/markMessageAsRead/${inst}`, { readMessages });
  }

  async sendPresence(instanceName: string, number: string, presence: 'composing' | 'recording' | 'paused') {
    const inst = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
    return this.request('POST', `chat/sendPresence/${inst}`, {
      number,
      options: { delay: 2000, presence },
    });
  }

  // --- CONFIGURAÇÕES DE INSTÂNCIA ---

  async setInstanceSettings(instanceName: string, settings: Record<string, any>) {
    const inst = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
    return this.request('POST', `settings/set/${inst}`, settings);
  }

  // --- GESTÃO DE INSTÂNCIAS ---

  async listInstances(tenantId?: string | null, timeoutMs?: number) {
    // Onda 17.32.129 — Fase 6.1: per-tenant. Passa tenantId pro request
    // pra usar a Evolution config do tenant (URL + key) em vez do global.
    const data = await this.request('GET', 'instance/fetchInstances', undefined, timeoutMs, tenantId);
    // Na v2, a Evolution retorna [{ instance: { ... } }] ou um objeto com { data: [...] }
    let instancesArray = (data as any)?.instances || (data as any)?.data || data;
    
    if (Array.isArray(instancesArray)) {
      return instancesArray.map(item => {
        const inst = item.instance || item;

        // Tenta encontrar o status em vários lugares comuns na v2 e v1
        const rawStatus = (
          inst.status ||
          inst.state ||
          inst.connectionStatus ||
          inst.connection?.state ||
          'connecting'
        ).toString().toLowerCase();

        // Mapeamento extra-robusto para 'open' (o que o front espera)
        const isOnline = ['open', 'connected', 'online', 'authenticated'].includes(rawStatus);
        const finalStatus = isOnline ? 'open' : rawStatus;

        // Onda 17.32.134 — Extrai numero + foto do perfil pra UI
        // Evolution v2 expoe esses campos com nomes variaveis.
        const profilePictureUrl =
          inst.profilePicUrl ||
          inst.profilePictureUrl ||
          inst.profile_pic_url ||
          inst.pictureUrl ||
          null;
        const profileName =
          inst.profileName ||
          inst.profile_name ||
          inst.pushName ||
          null;
        const phoneNumber = this.extractPhoneNumber(inst);

        return {
          ...inst,
          instanceName: inst.instanceName || inst.name || inst.id || 'Instância sem Nome',
          status: finalStatus,
          profilePictureUrl,
          profileName,
          phoneNumber,
        };
      });
    }

    return data;
  }

  /**
   * Extrai numero E.164 sem o '+' a partir do ownerJid da Evolution
   * (formato: "5511999999999@s.whatsapp.net") ou de outros campos.
   */
  private extractPhoneNumber(inst: any): string | null {
    const candidates = [
      inst.ownerJid, inst.owner, inst.wuid, inst.jid, inst.number, inst.phone, inst.phoneNumber,
    ];
    for (const c of candidates) {
      if (!c || typeof c !== 'string') continue;
      // Remove sufixos do tipo "@s.whatsapp.net" / "@c.us"
      const cleaned = c.split('@')[0].replace(/\D/g, '');
      if (cleaned.length >= 10) return cleaned;
    }
    return null;
  }

  async createInstance(instanceName: string) {
    const randomToken = crypto.randomBytes(12).toString('hex');
    const config = await this.settingsService.getWhatsAppConfig();
    
    const payload: any = {
      instanceName,
      token: randomToken,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      rejectCall: true,
      msgCall: 'No momento estamos atendendo apenas por mensagem de texto. Por favor, envie sua mensagem aqui.',
      alwaysOnline: true,
    };

    if (!config.webhookUrl) {
      throw new BadRequestException(
        'URL do Webhook não configurada. Acesse Configurações → WhatsApp, preencha a URL do servidor Evolution e salve antes de criar uma instância.',
      );
    }

    this.logger.log(`Provisionando instância ${instanceName} com webhook: ${config.webhookUrl}`);
    payload.webhook = {
      enabled: true,
      url: config.webhookUrl,
      byEvents: false,
      base64: false,
      retryDelay: 5000,
      maxRetries: 5,
      events: [
        'APPLICATION_STARTUP',
        'QRCODE_UPDATED',
        'MESSAGES_SET',
        'MESSAGES_UPSERT',
        'MESSAGES_UPDATE',
        'MESSAGES_DELETE',
        'SEND_MESSAGE',
        'CONTACTS_SET',
        'CONTACTS_UPSERT',
        'CONTACTS_UPDATE',
        'PRESENCE_UPDATE',
        'CHATS_SET',
        'CHATS_UPSERT',
        'CHATS_UPDATE',
        'CHATS_DELETE',
        'GROUP_PARTICIPANTS_UPDATE',
        'GROUP_UPDATE',
        'GROUPS_UPSERT',
        'CONNECTION_UPDATE',
        'CALL',
        'TYPEBOT_START',
        'TYPEBOT_CHANGE_STATUS',
      ],
    };

    const result = await this.request('POST', 'instance/create', payload);
    this.logger.log(`✅ Instância ${instanceName} criada com provisionamento automático.`);
    
    return result;
  }

  async deleteInstance(instanceName: string) {
    return this.request('DELETE', `instance/delete/${instanceName}`);
  }

  async logoutInstance(instanceName: string) {
    return this.request('DELETE', `instance/logout/${instanceName}`);
  }

  async getConnectCode(instanceName: string) {
    return this.request('GET', `instance/connect/${instanceName}`);
  }

  async getConnectionStatus(instanceName: string) {
    return this.request('GET', `instance/connectionStatus/${instanceName}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Onda 17.32.130 — UX "Conectar WhatsApp via QR" sem config tecnica
  //
  // Tenant nao ve URL/chave/webhook. Backend cria a instancia auto-
  // maticamente no servidor Evolution global, com naming pattern
  // derivado do tenant_id. Filtragem por prefixo + override em
  // TenantSetting pra instancias legacy.
  // ═══════════════════════════════════════════════════════════════════

  /** Prefixo de instancias do tenant — primeiros 8 chars do uuid sem hifens. */
  private tenantPrefix(tenantId: string): string {
    const clean = tenantId.replace(/-/g, '').slice(0, 8).toLowerCase();
    return `t${clean}`;
  }

  /** Le o display_name (apelido) salvo em TenantSetting. */
  private async getInstanceDisplayMap(tenantId: string): Promise<Record<string, string>> {
    try {
      const ts = await this.prisma.tenantSetting.findUnique({
        where: { tenant_id_key: { tenant_id: tenantId, key: 'WHATSAPP_INSTANCE_NAMES_JSON' } },
      });
      if (!ts?.value) return {};
      return JSON.parse(ts.value);
    } catch {
      return {};
    }
  }

  /** Salva o display_name em TenantSetting (merge). */
  private async saveInstanceDisplayName(tenantId: string, instanceName: string, displayName: string): Promise<void> {
    const map = await this.getInstanceDisplayMap(tenantId);
    map[instanceName] = displayName;
    await this.prisma.tenantSetting.upsert({
      where:  { tenant_id_key: { tenant_id: tenantId, key: 'WHATSAPP_INSTANCE_NAMES_JSON' } },
      create: { tenant_id: tenantId, key: 'WHATSAPP_INSTANCE_NAMES_JSON', value: JSON.stringify(map) },
      update: { value: JSON.stringify(map) },
    });
  }

  /** Remove display_name (quando deleta a instancia). */
  private async removeInstanceDisplayName(tenantId: string, instanceName: string): Promise<void> {
    const map = await this.getInstanceDisplayMap(tenantId);
    if (!(instanceName in map)) return;
    delete map[instanceName];
    await this.prisma.tenantSetting.upsert({
      where:  { tenant_id_key: { tenant_id: tenantId, key: 'WHATSAPP_INSTANCE_NAMES_JSON' } },
      create: { tenant_id: tenantId, key: 'WHATSAPP_INSTANCE_NAMES_JSON', value: JSON.stringify(map) },
      update: { value: JSON.stringify(map) },
    });
  }

  /** Le o nome legado (Onda anterior) se existir — pra continuar mostrando instancias antigas do tenant. */
  private async getLegacyInstanceName(tenantId: string): Promise<string | null> {
    try {
      const ts = await this.prisma.tenantSetting.findUnique({
        where: { tenant_id_key: { tenant_id: tenantId, key: 'EVOLUTION_INSTANCE_NAME' } },
      });
      return ts?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Lista as instancias QUE PERTENCEM A ESSE TENANT:
   *   - Naming pattern  (instanceName comeca com `t{hash8}-`)
   *   - Legacy override (TenantSetting EVOLUTION_INSTANCE_NAME)
   */
  async listForTenant(tenantId: string) {
    const prefix = this.tenantPrefix(tenantId);
    const [evoRaw, legacy, displayMap] = await Promise.all([
      this.listInstances(null, 8000).catch(() => []),
      this.getLegacyInstanceName(tenantId).catch(() => null),
      this.getInstanceDisplayMap(tenantId).catch(() => ({} as Record<string, string>)),
    ]);

    // BLINDAGEM (Onda 17.64.x): quando o fetchInstances da Evolution dá TIMEOUT,
    // o request retorna {statusCode:408} (objeto, NÃO array). Fazer .filter nisso
    // quebrava a listagem inteira (500 "não carregou"). Agora: se não vier array,
    // trata como vazio e cai na fonte estável (nosso banco) — os chips NÃO somem.
    const evo: any[] = Array.isArray(evoRaw) ? evoRaw : [];

    const evoMine = evo.filter((i) => {
      const name: string = i?.instanceName || '';
      return name.startsWith(`${prefix}-`) || (!!legacy && name === legacy);
    });

    // Self-healing (best-effort, nunca bloqueia a listagem): registra na tabela
    // Instance + vincula Inbox os chips que a Evolution retornou.
    await Promise.all(
      evoMine
        .filter((i) => (i.instanceName || '').startsWith(`${prefix}-`))
        .map((i) => this.ensureInstanceRegistered(tenantId, i.instanceName, displayMap[i.instanceName])),
    ).catch(() => {});

    // Fonte de verdade dos CHIPS = nossa tabela Instance (não some se a Evolution
    // cair). A Evolution só sobrepõe status/perfil quando responde.
    const dbRows = await this.prisma.instance.findMany({
      where: { tenant_id: tenantId, type: 'whatsapp' },
      select: { name: true, purpose: true },
    });
    const purposeByName = new Map<string, any>(dbRows.map((r) => [r.name, r.purpose]));
    const evoByName = new Map<string, any>(evoMine.map((i) => [i.instanceName, i]));

    // União deduplicada: chips do banco (sempre) + os que só a Evolution trouxe + legacy.
    const names = new Set<string>();
    for (const r of dbRows) if (r.name.startsWith(`${prefix}-`)) names.add(r.name);
    for (const i of evoMine) if (i.instanceName) names.add(i.instanceName);
    if (legacy) names.add(legacy);

    return [...names].map((name) => {
      const e = evoByName.get(name) || {};
      return {
        ...e,
        instanceName: name,
        displayName: displayMap[name] || this.guessDisplayName(name, prefix),
        isLegacy: !!legacy && name === legacy,
        purpose: purposeByName.get(name) ?? null,
        // Status da Evolution quando disponível; senão 'unknown' (chip aparece,
        // só não confirma o status ao vivo — melhor que sumir + erro).
        status: e.status || 'unknown',
      };
    });
  }

  /** Pega "Linha 1" de "t1234abcd-1" ou usa o proprio nome se for legacy. */
  private guessDisplayName(instanceName: string, prefix: string): string {
    const m = instanceName.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) return `Linha ${m[1]}`;
    return instanceName; // legacy: mostra o nome cru
  }

  /** Onda 17.64 / 18.7 — normaliza a função do chip:
   *  'COMERCIAL' | 'CLINICA' | 'FINANCEIRO' | null. */
  private normalizePurpose(purpose?: string | null): 'COMERCIAL' | 'CLINICA' | 'FINANCEIRO' | null {
    const p = (purpose || '').trim().toUpperCase();
    return p === 'COMERCIAL' || p === 'CLINICA' || p === 'FINANCEIRO'
      ? (p as 'COMERCIAL' | 'CLINICA' | 'FINANCEIRO')
      : null;
  }

  /** Rótulo amigável da função (pra mensagens/nome de inbox). */
  private purposeLabel(purpose: string): string {
    return purpose === 'COMERCIAL' ? 'Comercial'
      : purpose === 'CLINICA' ? 'Clínica'
      : purpose === 'FINANCEIRO' ? 'Financeiro'
      : 'WhatsApp';
  }

  /**
   * Onda 18.7 — Resolve a instância (chip) do tenant por função, pra rotear
   * saída por propósito (ex: cobrança sai pelo chip FINANCEIRO). Retorna o
   * `name` da instância viva daquela função, ou null se não houver.
   */
  async getInstanceForPurpose(tenantId: string, purpose: string): Promise<string | null> {
    const norm = this.normalizePurpose(purpose);
    if (!tenantId || !norm) return null;
    const inst = await this.prisma.instance.findFirst({
      where: { tenant_id: tenantId, type: 'whatsapp', purpose: norm },
      orderBy: { created_at: 'asc' },
      select: { name: true },
    });
    return inst?.name ?? null;
  }

  /**
   * Onda 17.33 — Garante que a instancia do tenant esta REGISTRADA na tabela
   * Instance (Prisma) e vinculada a um Inbox. Sem esse registro, o webhook
   * da Evolution (evolution.service.handleMessagesUpsert) nao resolve o
   * tenant e as conversas nascem com tenant_id=null/inbox_id=null —
   * invisiveis pra todo mundo (bug "conectou mas mensagens nao chegam").
   *
   * Idempotente e self-healing:
   *   1. So atua em instancias do padrao do tenant (t<hash8>-N). Instancias
   *      legadas (override EVOLUTION_INSTANCE_NAME, ex "Comercial") sao
   *      IGNORADAS — podem ser compartilhadas e ja tem vinculo manual.
   *   2. Upsert da Instance com tenant_id.
   *   3. Vincula a um Inbox: usa o inbox mais antigo do tenant SEM instancia
   *      vinculada; se nao houver, cria um default com o displayName e
   *      conecta todos os usuarios do tenant (pra operadores enxergarem).
   *   4. Backfill: conversas/leads orfaos (tenant_id null) daquela instancia
   *      ganham tenant_id + inbox_id retroativamente.
   *
   * Chamado no quickConnect (novas conexoes) e no listForTenant (repara
   * instancias criadas antes deste fix quando a tela de WhatsApp abre).
   */
  private async ensureInstanceRegistered(
    tenantId: string,
    instanceName: string,
    displayName?: string,
    purpose?: 'COMERCIAL' | 'CLINICA' | 'FINANCEIRO' | null,
  ): Promise<void> {
    const prefix = this.tenantPrefix(tenantId);
    if (!instanceName.startsWith(`${prefix}-`)) return; // legacy/foreign: nao mexe

    try {
      const existing = await this.prisma.instance.findUnique({
        where: { name: instanceName },
        select: { id: true, tenant_id: true, inbox_id: true },
      });

      // Ja registrada com tenant + inbox? Nada a fazer (caminho quente do
      // listForTenant — 1 query e sai). purpose só é setado na CRIAÇÃO (via
      // quickConnect) ou no setPurposeForTenant; o self-heal não re-tagueia.
      if (existing?.tenant_id && existing?.inbox_id) return;

      // Resolve o inbox alvo. COM função (Onda 17.64): reusa/cria o inbox DAQUELA
      // função (separa os times). SEM função (legado/self-heal): mais antigo do
      // tenant sem instancia vinculada, senao cria um default — comportamento atual.
      let inboxId: string | null = existing?.inbox_id ?? null;
      if (!inboxId) {
        if (purpose) {
          const fnInbox = await this.prisma.inbox.findFirst({
            where: { tenant_id: tenantId, purpose },
            orderBy: { created_at: 'asc' },
            select: { id: true },
          });
          if (fnInbox) inboxId = fnInbox.id;
        } else {
          const freeInbox = await this.prisma.inbox.findFirst({
            where: { tenant_id: tenantId, instances: { none: {} } },
            orderBy: { created_at: 'asc' },
            select: { id: true },
          });
          if (freeInbox) inboxId = freeInbox.id;
        }
        if (!inboxId) {
          const tenantUsers = await this.prisma.user.findMany({
            where: { tenant_id: tenantId },
            select: { id: true },
          });
          const createdInbox = await this.prisma.inbox.create({
            data: {
              name: (displayName || '').trim() ||
                (purpose ? this.purposeLabel(purpose) : 'WhatsApp da clinica'),
              tenant_id: tenantId,
              purpose: purpose ?? null,
              auto_route: false,
              users: tenantUsers.length > 0
                ? { connect: tenantUsers.map((u) => ({ id: u.id })) }
                : undefined,
            },
            select: { id: true },
          });
          inboxId = createdInbox.id;
          this.logger.log(
            `[ENSURE-INSTANCE] Inbox ${purpose ? `(${purpose}) ` : 'default '}criado pro tenant ${tenantId} (${tenantUsers.length} usuarios conectados)`,
          );
        }
      }

      await this.prisma.instance.upsert({
        where: { name: instanceName },
        create: {
          name: instanceName,
          type: 'whatsapp',
          tenant_id: tenantId,
          inbox_id: inboxId,
          ...(purpose ? { purpose } : {}),
        },
        update: {
          tenant_id: tenantId,
          inbox_id: inboxId,
          ...(purpose ? { purpose } : {}),
        },
      });

      // Backfill de conversas/leads orfaos criados ANTES do registro
      const convFix = await this.prisma.conversation.updateMany({
        where: { instance_name: instanceName, tenant_id: null },
        data: { tenant_id: tenantId, inbox_id: inboxId },
      });
      const convInboxFix = await this.prisma.conversation.updateMany({
        where: { instance_name: instanceName, tenant_id: tenantId, inbox_id: null },
        data: { inbox_id: inboxId },
      });
      const leadFix = await this.prisma.lead.updateMany({
        where: {
          tenant_id: null,
          conversations: { some: { instance_name: instanceName } },
        },
        data: { tenant_id: tenantId },
      });

      this.logger.log(
        `[ENSURE-INSTANCE] "${instanceName}" registrada pro tenant ${tenantId} ` +
        `(inbox=${inboxId}, backfill: ${convFix.count + convInboxFix.count} conversas, ${leadFix.count} leads)`,
      );
    } catch (e: any) {
      // Best-effort: nao pode quebrar a listagem/conexao por falha de registro
      this.logger.error(`[ENSURE-INSTANCE] Falha ao registrar "${instanceName}": ${e?.message}`);
    }
  }

  /**
   * Conecta um novo WhatsApp pro tenant:
   *   1. Calcula proximo numero disponivel (1, 2, 3, ...)
   *   2. Cria a instancia na Evolution (usa config GLOBAL — tenant nao precisa configurar nada)
   *   3. Salva o apelido em TenantSetting
   *   4. Retorna QR code pro tenant escanear
   */
  async quickConnect(tenantId: string, displayName?: string, purpose?: string) {
    const prefix = this.tenantPrefix(tenantId);
    const normalizedPurpose = this.normalizePurpose(purpose);
    const existing = await this.listForTenant(tenantId);

    // Onda 17.64 / 18.7 — limite por FUNÇÃO: no máximo 3 WhatsApps por clínica,
    // no máximo 1 de cada função (COMERCIAL=Leads, CLINICA=Pacientes,
    // FINANCEIRO=cobrança/lembrete). Sem função informada (cliente antigo),
    // mantém o limite legado de 1/tenant.
    if (normalizedPurpose) {
      const sameFn = (existing as any[]).find((e) => e.purpose === normalizedPurpose);
      if (sameFn) {
        throw new BadRequestException(
          `Sua clinica ja tem um WhatsApp ${this.purposeLabel(normalizedPurpose)} ("${sameFn.displayName || sameFn.instanceName}"). ` +
          `Pra trocar, remova a linha atual primeiro.`,
        );
      }
      if (existing.length >= 3) {
        throw new BadRequestException(
          'Limite de 3 WhatsApps por clinica (1 Comercial + 1 Clinica + 1 Financeiro) atingido.',
        );
      }
    } else if (existing.length > 0) {
      const current = existing[0];
      throw new BadRequestException(
        `Sua clinica ja possui um WhatsApp conectado ("${current.displayName || current.instanceName}"). ` +
        `Pra trocar de numero, remova a linha atual primeiro.`,
      );
    }

    // Próximo índice livre dos nomes t<hash>-N (robusto a buracos: se só existe
    // o "-2", o próximo vira "-1"; nunca colide com name @unique).
    const usedN = new Set<number>(
      (existing as any[])
        .map((e) => {
          const m = (e.instanceName || '').match(new RegExp(`^${prefix}-(\\d+)$`));
          return m ? parseInt(m[1], 10) : null;
        })
        .filter((n): n is number => n != null),
    );
    let nextN = 1;
    while (usedN.has(nextN)) nextN++;
    const instanceName = `${prefix}-${nextN}`;
    const finalDisplayName = (displayName || '').trim() ||
      (normalizedPurpose ? this.purposeLabel(normalizedPurpose) : 'WhatsApp da clinica');

    this.logger.log(
      `[quickConnect] Criando instancia ${instanceName} pro tenant ${tenantId} ` +
      `("${finalDisplayName}", funcao=${normalizedPurpose ?? 'geral'})`,
    );

    // Cria a instancia (usa config global automaticamente)
    await this.createInstance(instanceName);

    // Salva o apelido
    await this.saveInstanceDisplayName(tenantId, instanceName, finalDisplayName);

    // Onda 17.33 — Registra a instancia no Prisma (Instance + Inbox + backfill).
    // Sem isso o webhook da Evolution nao resolve o tenant e as mensagens
    // recebidas viram conversas orfaas invisiveis. Onda 17.64: leva a função.
    await this.ensureInstanceRegistered(tenantId, instanceName, finalDisplayName, normalizedPurpose);

    // Busca QR
    let qr: any = null;
    try {
      qr = await this.getConnectCode(instanceName);
    } catch (e: any) {
      this.logger.warn(`[quickConnect] QR ainda nao disponivel pra ${instanceName}: ${e?.message}`);
    }

    return {
      instanceName,
      displayName: finalDisplayName,
      purpose: normalizedPurpose,
      qr,
    };
  }

  /**
   * Onda 17.64 — define/troca a FUNÇÃO de um chip já conectado (COMERCIAL|CLINICA).
   * O tenant com 1 chip legado precisa marcar a função dele ANTES de adicionar o
   * 2º (a UI gateia por isso). Valida ownership (prefixo/legacy), recusa se já há
   * outro chip do tenant com essa função, e tagueia Instance.purpose + o Inbox
   * VINCULADO (sem mover conversas/operadores — só carimba a função).
   */
  async setPurposeForTenant(tenantId: string, instanceName: string, purpose?: string) {
    const prefix = this.tenantPrefix(tenantId);
    const legacy = await this.getLegacyInstanceName(tenantId);
    const isMine = instanceName.startsWith(`${prefix}-`) || instanceName === legacy;
    if (!isMine) {
      throw new BadRequestException('Essa linha de WhatsApp nao pertence a sua clinica');
    }
    const normalized = this.normalizePurpose(purpose);
    if (!normalized) {
      throw new BadRequestException('Funcao invalida (use COMERCIAL, CLINICA ou FINANCEIRO)');
    }

    // Garante que a instância está registrada (self-heal) antes de taguear.
    await this.ensureInstanceRegistered(tenantId, instanceName, undefined);

    // Recusa se OUTRO chip do tenant já tem essa função (1 de cada).
    const conflict = await this.prisma.instance.findFirst({
      where: { tenant_id: tenantId, purpose: normalized, name: { not: instanceName } },
      select: { name: true },
    });
    if (conflict) {
      throw new BadRequestException(
        `Sua clinica ja tem um WhatsApp ${this.purposeLabel(normalized)} ("${conflict.name}").`,
      );
    }

    const inst = await this.prisma.instance.findUnique({
      where: { name: instanceName },
      select: { inbox_id: true, tenant_id: true, purpose: true },
    });
    if (!inst || inst.tenant_id !== tenantId) {
      throw new BadRequestException(
        'Linha ainda nao registrada pra sua clinica — reabra a tela e tente de novo.',
      );
    }
    // Idempotente se já é a mesma função.
    if (inst.purpose === normalized) {
      return { ok: true, purpose: normalized, idempotent: true };
    }

    // Onda 17.64 — SELECIONAR/TROCAR a função a QUALQUER momento. Em vez de só
    // carimbar o inbox atual (deixaria conversas da função antiga misturadas),
    // RE-VINCULA o chip ao inbox DA FUNÇÃO-ALVO: as PRÓXIMAS conversas caem no
    // setor certo; as antigas ficam no inbox onde nasceram (histórico preservado).
    // Reusa o inbox da função se já existir (não prolifera setor).
    let targetInbox = await this.prisma.inbox.findFirst({
      where: { tenant_id: tenantId, purpose: normalized },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });
    if (!targetInbox) {
      const tenantUsers = await this.prisma.user.findMany({
        where: { tenant_id: tenantId },
        select: { id: true },
      });
      targetInbox = await this.prisma.inbox.create({
        data: {
          name: this.purposeLabel(normalized),
          tenant_id: tenantId,
          purpose: normalized,
          auto_route: false,
          users: tenantUsers.length > 0
            ? { connect: tenantUsers.map((u) => ({ id: u.id })) }
            : undefined,
        },
        select: { id: true },
      });
    }
    await this.prisma.instance.update({
      where: { name: instanceName },
      data: { purpose: normalized, inbox_id: targetInbox.id },
    });
    this.logger.log(
      `[setPurpose] ${instanceName} (tenant ${tenantId}) -> funcao=${normalized}` +
      `${inst.purpose ? ` (trocado de ${inst.purpose})` : ''}, inbox=${targetInbox.id}`,
    );
    return { ok: true, purpose: normalized };
  }

  /**
   * Deleta uma instancia do tenant. Valida que o instanceName pertence
   * mesmo ao tenant (naming pattern ou legacy override) — protege contra
   * tenant A apagar instancia do tenant B.
   */
  async deleteForTenant(tenantId: string, instanceName: string) {
    const prefix = this.tenantPrefix(tenantId);
    const legacy = await this.getLegacyInstanceName(tenantId);
    const isMine = instanceName.startsWith(`${prefix}-`) || instanceName === legacy;
    if (!isMine) {
      throw new BadRequestException('Essa linha de WhatsApp nao pertence a sua clinica');
    }
    await this.deleteInstance(instanceName);
    // Onda 17.64 — apaga TAMBÉM a linha Instance do Prisma. Sem isso, o resolvedor
    // por função (resolveTenantWhatsappInstance / resolveTenantInstance) continuaria
    // roteando os disparos clínicos pra esse chip MORTO (entrega falharia calada,
    // mesmo após reconectar). deleteMany = não lança se a linha já não existir.
    await this.prisma.instance
      .deleteMany({ where: { name: instanceName, tenant_id: tenantId } })
      .catch((e: any) => this.logger.warn(`[deleteForTenant] Falha ao apagar linha Instance ${instanceName}: ${e?.message}`));
    await this.removeInstanceDisplayName(tenantId, instanceName).catch(() => {});
    return { ok: true };
  }

  /**
   * Reconecta uma instancia ja existente (gera novo QR). Mesma validacao
   * de ownership do deleteForTenant.
   */
  async reconnectForTenant(tenantId: string, instanceName: string) {
    const prefix = this.tenantPrefix(tenantId);
    const legacy = await this.getLegacyInstanceName(tenantId);
    const isMine = instanceName.startsWith(`${prefix}-`) || instanceName === legacy;
    if (!isMine) {
      throw new BadRequestException('Essa linha de WhatsApp nao pertence a sua clinica');
    }
    return this.getConnectCode(instanceName);
  }

  /** Renomeia o apelido (display_name) — nao mexe na Evolution, so em TenantSetting. */
  async renameForTenant(tenantId: string, instanceName: string, newDisplayName: string) {
    const prefix = this.tenantPrefix(tenantId);
    const legacy = await this.getLegacyInstanceName(tenantId);
    const isMine = instanceName.startsWith(`${prefix}-`) || instanceName === legacy;
    if (!isMine) {
      throw new BadRequestException('Essa linha de WhatsApp nao pertence a sua clinica');
    }
    const trimmed = newDisplayName.trim();
    if (!trimmed) throw new BadRequestException('O apelido nao pode ficar vazio');
    await this.saveInstanceDisplayName(tenantId, instanceName, trimmed);
    return { ok: true, displayName: trimmed };
  }

  async setWebhook(instanceName: string, url: string, tenantId?: string | null) {
    return this.request('POST', `webhook/set/${instanceName}`, {
      url,
      enabled: true,
      webhook_by_events: false,
      // Retry automático: tenta reenviar até 10 vezes com intervalo de 15s
      // (2,5 min de tolerância total). Garante entrega mesmo se o CRM estiver
      // temporariamente indisponível durante reinicialização ou queda breve.
      // Para quedas maiores, o `onApplicationBootstrap` do EvolutionService
      // dispara um resync completo ao voltar do ar.
      retryDelay: 15000,
      maxRetries: 10,
      events: [
        'MESSAGES_UPSERT',
        'MESSAGES_UPDATE',
        'MESSAGES_DELETE',
        'SEND_MESSAGE',
        'CONNECTION_UPDATE',
        'PRESENCE_UPDATE',
        'CHATS_UPSERT',
        'CHATS_UPDATE',
        'CHATS_DELETE',
        'CONTACTS_UPSERT',
        'CONTACTS_UPDATE',
        'CONTACTS_SET',
      ],
    }, undefined, tenantId);
  }

  async fetchContacts(instanceName: string) {
    try {
      // POST /chat/findContacts com { where: {} } para trazer TODOS os contatos
      let data = await this.request(
        'POST',
        `chat/findContacts/${instanceName}`,
        { where: {} },
      );

      // Fallback: GET endpoints antigos
      if (!data || (data as any).statusCode === 404 || (data as any).error) {
        this.logger.log(`findContacts indisponível para ${instanceName}, tentando fetchContacts...`);
        data = await this.request('GET', `chat/fetchContacts/${instanceName}`);
      }
      if (!data || (data as any).statusCode === 404 || (data as any).error ||
          !((data as any).data || (Array.isArray(data) && data.length > 0))) {
        this.logger.log(`fetchContacts indisponível para ${instanceName}, tentando contact/find...`);
        data = await this.request('GET', `contact/find/${instanceName}`);
      }

      const list = Array.isArray(data) ? data : (data as any)?.data || [];
      this.logger.log(`fetchContacts ${instanceName}: ${list.length} contatos retornados`);
      return list;
    } catch (e) {
      this.logger.error(`Erro ao buscar contatos para ${instanceName}: ${e}`);
      return [];
    }
  }

  async fetchProfilePicture(instanceName: string, number: string) {
    try {
      // Evolution API aceita tanto "5511999..." quanto "5511999...@s.whatsapp.net"
      const cleanNumber = number.replace(/@s\.whatsapp\.net$/, '');
      const data = await this.request(
        'POST',
        `chat/fetchProfilePictureUrl/${instanceName}`,
        { number: cleanNumber },
      );
      const url = data?.profilePictureUrl || data?.profile_picture || data?.data?.profile_picture || data?.url || null;
      if (!url) {
        this.logger.debug(`[fetchProfilePicture] Sem foto para ${cleanNumber} na instância ${instanceName}. Resposta: ${JSON.stringify(data)}`);
      }
      return url;
    } catch (e: any) {
      this.logger.debug(`[fetchProfilePicture] Erro ao buscar foto de ${number}: ${e?.message}`);
      return null;
    }
  }

  async fetchMessages(instanceName: string, remoteJid: string): Promise<any[]> {
    // Evolution API v2.3+ retorna: { messages: { total, pages, currentPage, records: [...] } }
    // Versões mais antigas retornam um array direto — tratamos os dois formatos.
    let allMessages: any[] = [];

    try {
      let currentPage = 1;
      let totalPages = 1;

      do {
        const data: any = await this.request(
          'POST',
          `chat/findMessages/${instanceName}`,
          { where: { key: { remoteJid } }, page: currentPage },
          30000, // fetchMessages pode ser lento com historicos grandes
        );

        if (data?.error || data?.statusCode >= 400) {
          this.logger.warn(`fetchMessages error for ${remoteJid}: ${JSON.stringify(data)}`);
          break;
        }

        // Normaliza os dois formatos de resposta
        let records: any[];
        if (Array.isArray(data)) {
          // Formato antigo: array direto
          records = data;
          totalPages = 1; // sem paginação neste formato
        } else if (data?.messages?.records) {
          // Formato v2.3+: { messages: { total, pages, currentPage, records } }
          records = data.messages.records;
          totalPages = data.messages.pages ?? 1;
        } else if (Array.isArray(data?.messages)) {
          // Formato intermediário: { messages: [...] }
          records = data.messages;
          totalPages = 1;
        } else {
          records = data?.data || [];
          totalPages = 1;
        }

        if (records.length === 0) break;

        allMessages = allMessages.concat(records);
        this.logger.log(
          `fetchMessages ${instanceName}/${remoteJid} page ${currentPage}/${totalPages}: ${records.length} msgs (total: ${allMessages.length})`,
        );

        currentPage++;
      } while (currentPage <= totalPages);

      // Ordena cronologicamente (mais antigo primeiro)
      allMessages.sort((a, b) => {
        const ta = Number(a.messageTimestamp ?? a.key?.timestamp ?? 0);
        const tb = Number(b.messageTimestamp ?? b.key?.timestamp ?? 0);
        return ta - tb;
      });

      this.logger.log(`fetchMessages ${instanceName}/${remoteJid}: ${allMessages.length} msgs totais`);
      return allMessages;
    } catch (e) {
      this.logger.error(`Erro ao buscar mensagens para ${remoteJid}: ${e}`);
      return allMessages;
    }
  }

  async fetchChats(instanceName: string) {
    try {
      // POST /chat/findChats com { where: {} } para trazer TODOS os chats (incluindo não salvos)
      let data = await this.request(
        'POST',
        `chat/findChats/${instanceName}`,
        { where: {} },
      );

      // Fallback: GET /chat/fetchChats
      if (!data || (data as any).statusCode === 404 || (data as any).error) {
        this.logger.log(`findChats indisponível para ${instanceName}, tentando fetchChats (GET)...`);
        data = await this.request('GET', `chat/fetchChats/${instanceName}`);
      }

      if (!data || (data as any).statusCode >= 400 || (data as any).error) {
        this.logger.error(`Falha ao buscar chats para ${instanceName}: ${JSON.stringify(data)}`);
        return [];
      }

      const list = Array.isArray(data) ? data : (data as any)?.data || [];
      this.logger.log(`fetchChats ${instanceName}: ${list.length} chats retornados`);

      // Se poucos resultados, tentar paginar (algumas versões limitam por padrão)
      if (list.length > 0) {
        let allChats = [...list];
        let page = 2;
        const pageSize = list.length; // usar o tamanho da primeira página como referência

        // Se a primeira página retornou um número "redondo" (múltiplo de 50/100), provavelmente há mais
        while (pageSize >= 50 && page <= 20) {
          try {
            const moreData = await this.request(
              'POST',
              `chat/findChats/${instanceName}`,
              { where: {}, page, limit: pageSize },
            );
            const moreList = Array.isArray(moreData) ? moreData : (moreData as any)?.data || [];
            if (moreList.length === 0) break;
            allChats = [...allChats, ...moreList];
            this.logger.log(`fetchChats ${instanceName} page ${page}: +${moreList.length} chats`);
            if (moreList.length < pageSize) break; // última página
            page++;
          } catch {
            break; // paginação não suportada nesta versão
          }
        }

        if (allChats.length > list.length) {
          this.logger.log(`fetchChats ${instanceName}: total ${allChats.length} chats após paginação`);
        }
        return allChats;
      }

      return list;
    } catch (e) {
      this.logger.error(`Erro ao buscar chats para ${instanceName}: ${e}`);
      return [];
    }
  }

  async syncContacts(instanceName: string, tenantId?: string) {
    // 0. Buscar o inbox vinculado a esta instância para marcar as conversas corretamente
    const inbox = await (this.prisma as any).instance.findUnique({
      where: { name: instanceName },
      include: { inbox: true }
    });
    const inboxId = inbox?.inbox_id || null;

    // Busca apenas chats — inclui contatos não salvos na agenda (via pushName do WhatsApp)
    // findContacts só retorna quem está salvo na agenda e foi removido propositalmente
    const chatsList = await this.fetchChats(instanceName);

    this.logger.log(`Sync ${instanceName}: ${chatsList.length} chats para o setor ${inbox?.inbox?.name || 'Nenhum'}`);

    // Log amostra da estrutura para debug
    if (chatsList.length > 0) {
      this.logger.log(`Amostra chat[0] keys: ${Object.keys(chatsList[0]).join(', ')}`);
      this.logger.log(`Amostra chat[0]: ${JSON.stringify(chatsList[0]).substring(0, 300)}`);
    }

    const allEntries = chatsList;

    if (allEntries.length === 0) {
      return { total: 0, synced: 0, error: 'Nenhum chat encontrado' };
    }

    const seenPhones = new Set<string>();
    let updatedCount = 0;
    let skippedGroups = 0;
    let skippedInvalid = 0;

    for (const entry of allEntries) {
      try {
        // findChats retorna: { remoteJid, isGroup, pushName, profilePicUrl, ... }
        // findContacts retorna: { remoteJid, pushName, number, ... }
        const remoteJid: string = entry.remoteJid || '';

        // ---- FILTRAR GRUPOS, BROADCASTS, STATUS ----
        if (entry.isGroup === true) { skippedGroups++; continue; }
        if (remoteJid.includes('@g.us'))        { skippedGroups++; continue; }
        if (remoteJid.includes('@broadcast'))   { skippedGroups++; continue; }
        if (remoteJid.includes('status@'))      { skippedGroups++; continue; }
        if (remoteJid === 'status@broadcast')   { skippedGroups++; continue; }

        // ---- EXTRAIR PHONE ----
        let phone = '';

        const finalRemoteJid = entry.remoteJidAlt || entry.remoteJid || '';

        if (finalRemoteJid.includes('@s.whatsapp.net')) {
          phone = finalRemoteJid.split('@')[0];
        } else if (entry.number) {
          phone = String(entry.number);
        }

        phone = phone.replace(/\D/g, '');

        // Descartar inválidos
        if (!phone || phone.length < 10 || phone.length > 15) {
          skippedInvalid++;
          continue;
        }

        // Dedup: mesmo phone de contacts e chats
        if (seenPhones.has(phone)) continue;
        seenPhones.add(phone);

        // Jid para external_id da conversa
        const jid = remoteJid || `${phone}@s.whatsapp.net`;

        // Foto de perfil (usa profilePicUrl do findChats se disponível)
        const profilePictureUrl = entry.profilePicUrl ||
          await this.fetchProfilePicture(instanceName, phone);

        const lead = await this.leadsService.upsert({
          name: (entry.pushName || entry.name || entry.verifiedName || null) as string | null,
          phone: phone as string,
          profile_picture_url: profilePictureUrl || null,
          origin: 'whatsapp',
          tenant: tenantId ? { connect: { id: tenantId } } : undefined,
          stage: 'NOVO',
        });

        // Cria conversa se não existir ou atualiza metadados se faltarem
        let existingConv = await this.prisma.conversation.findFirst({
          where: {
            lead_id: lead.id,
            channel: 'whatsapp',
            status: 'ABERTO',
            // Se já tiver uma com o mesmo instance_name, OK. 
            // Se não tiver instance_name, tentamos achar pelo lead_id + canal
          },
        });

        if (!existingConv) {
          try {
            existingConv = await this.prisma.conversation.create({
              data: {
                lead_id: lead.id,
                channel: 'whatsapp',
                status: 'ABERTO',
                external_id: jid,
                instance_name: instanceName,
                inbox_id: inboxId,
                tenant_id: tenantId,
              },
            });
          } catch (e: any) {
            // Corrida (índice único parcial lead_id+inbox_id): reusa a conversa que
            // o outro criou em vez de duplicar/quebrar o sync.
            if (e?.code !== 'P2002') throw e;
            existingConv = await this.prisma.conversation.findFirst({
              where: { lead_id: lead.id, channel: 'whatsapp', status: { not: 'ENCERRADO' } },
              orderBy: { last_message_at: 'desc' },
            });
            if (!existingConv) throw e;
          }
        } else {
          // Garante que a conversa tenha os metadados corretos
          existingConv = await this.prisma.conversation.update({
            where: { id: existingConv.id },
            data: {
              instance_name: instanceName,
              inbox_id: inboxId,
              external_id: jid,
              tenant_id: tenantId || existingConv.tenant_id,
            },
          });
        }

        // 3. Sincronizar a Última Mensagem (para a conversa aparecer no Chat)
        if (entry.lastMessage && existingConv) {
          const lm = entry.lastMessage;
          const msgId = lm.key?.id || lm.id;
          const msgText = lm.message?.conversation || 
                          lm.message?.extendedTextMessage?.text || 
                          lm.message?.imageMessage?.caption || 
                          (lm.messageType !== 'conversation' ? `[${lm.messageType}]` : '');

          if (msgId && msgText) {
            await this.prisma.message.upsert({
              where: { external_message_id: msgId },
              update: {
                status: lm.status || 'recebido',
                text: msgText,
              },
              create: {
                conversation_id: existingConv.id,
                direction: lm.key?.fromMe ? 'out' : 'in',
                type: 'text', // Simplificado para o sync inicial
                text: msgText,
                external_message_id: msgId,
                status: lm.status || 'recebido',
                created_at: lm.messageTimestamp ? new Date(lm.messageTimestamp * 1000) : new Date(),
              },
            });

            // Atualiza o timestamp da conversa
            await this.prisma.conversation.update({
              where: { id: existingConv.id },
              data: { last_message_at: lm.messageTimestamp ? new Date(lm.messageTimestamp * 1000) : new Date() }
            });
          }
        }

        updatedCount++;
      } catch (e) {
        this.logger.error(
          `Erro ao sincronizar entrada: ${JSON.stringify(entry).substring(0, 200)} - ${e.message}`,
        );
      }
    }

    this.logger.log(
      `Sync ${instanceName} concluído: ${updatedCount} sincronizados, ` +
      `${skippedGroups} grupos/broadcasts ignorados, ${skippedInvalid} inválidos, ` +
      `${seenPhones.size} phones únicos de ${allEntries.length} chats`,
    );
    return { total: allEntries.length, synced: updatedCount, skippedGroups, skippedInvalid, uniquePhones: seenPhones.size };
  }

}
