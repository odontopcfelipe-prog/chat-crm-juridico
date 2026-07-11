import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { SettingsService } from '../../settings/settings.service';
import { PrismaService } from '../../prisma/prisma.service';

interface AsaasConfig {
  apiKey: string;
  baseUrl: string;
  sandbox: boolean;
  webhookToken: string;
}

interface CreateCustomerData {
  name: string;
  cpfCnpj: string;
  email?: string;
  phone?: string;
  externalReference?: string;
}

interface CreateChargeData {
  customer: string;
  billingType: string;
  value: number;
  dueDate: string;
  description?: string;
  externalReference?: string;
  postalService?: boolean;
  installmentCount?: number;  // Parcelamento: número de parcelas
  installmentValue?: number;  // Parcelamento: valor de cada parcela
}

interface ListChargesParams {
  customer?: string;
  status?: string;
  offset?: number;
  limit?: number;
}

@Injectable()
export class AsaasClient {
  private readonly logger = new Logger(AsaasClient.name);
  // Onda 17.8 — Reduzido de 3 pra 2: com timeout 30s + backoff exponencial,
  // 3 tentativas resultavam em ate 93s no pior caso, deixando o operador
  // esperando "loading" infinito no frontend. Com 2, pior caso = 20s + 1s + 20s
  // = 41s, dentro do timeout de 60s do frontend.
  private readonly MAX_RETRIES = 2;

  constructor(
    private settingsService: SettingsService,
    // Onda 17.32.82 — usado pra ler TenantSetting via helper
    private prisma: PrismaService,
  ) {}

  /**
   * Onda 17.32.82 — Aceita tenantId opcional. Quando passado, busca
   * settings DO TENANT primeiro (TenantSetting{tenant_id, key}). Fallback
   * pra GlobalSetting (compartilhada) + env var.
   *
   * Caller idealmente passa tenantId pra que cada tenant use sua propria
   * conta Asaas (revenda real). Quando undefined, mantem comportamento
   * legacy (settings globais).
   */
  async getConfig(tenantId?: string | null): Promise<AsaasConfig> {
    const { getTenantSetting } = await import('../../tenants/tenant-settings.helper.js');
    // Onda 18.x — ISOLAMENTO POR TENANT (anti-vazamento de cobrança entre clínicas).
    // Regra: operação com tenant explícito usa a chave DELE (TenantSetting, texto cru).
    // NUNCA cai na chave global de outra clínica. Exceção: o "dono" da chave global
    // (GlobalSetting ASAAS_GLOBAL_OWNER_TENANT — normalmente a matriz) segue usando a
    // global como conta dele. Enquanto o dono NÃO estiver setado, mantém o comportamento
    // LEGADO (fallback global p/ todos) — assim o DEPLOY do código não quebra ninguém; o
    // isolamento "liga" (e desliga) só ao setar/limpar esse GlobalSetting. Reversível.
    let apiKey: string | null = null;
    if (tenantId) {
      const ts = await this.prisma.tenantSetting
        .findUnique({ where: { tenant_id_key: { tenant_id: tenantId, key: 'ASAAS_API_KEY' } } })
        .catch(() => null);
      if (ts?.value) {
        apiKey = ts.value; // clínica com conta Asaas PRÓPRIA
      } else {
        const owner = await getTenantSetting(this.prisma, 'ASAAS_GLOBAL_OWNER_TENANT', null);
        if (!owner) {
          apiKey = await this.settingsService.get('asaas_api_key'); // isolamento não ativado (legado)
        } else if (owner === tenantId) {
          apiKey = await this.settingsService.get('asaas_api_key'); // dono da chave global (matriz)
        } else {
          apiKey = null; // clínica sem chave própria e não-dona → BLOQUEADA (não vaza p/ a matriz)
          this.logger.warn(`[ASAAS] tenant ${tenantId} sem chave propria e nao e o dono da global — cobranca BLOQUEADA (isolamento)`);
        }
      }
    } else {
      // Contexto legado/sistema sem tenant explícito: resolução com fallback global (como antes).
      const legacyKey = await getTenantSetting(this.prisma, 'ASAAS_API_KEY', null, 'ASAAS_API_KEY');
      apiKey = legacyKey || await this.settingsService.get('asaas_api_key');
    }

    const newBaseUrl = await getTenantSetting(this.prisma, 'ASAAS_BASE_URL', tenantId);
    const globalSandbox = (await this.settingsService.get('asaas_sandbox')) === 'true';
    const webhookToken = await this.settingsService.get('asaas_webhook_token');

    // Onda 17.32.82 — Base URL pode vir do TenantSetting (caso a clinica
    // queira usar sandbox/prod especifico). Senao deriva do flag global.
    const baseUrl = newBaseUrl
      ? (newBaseUrl.endsWith('/v3') ? newBaseUrl : `${newBaseUrl}/v3`)
      : globalSandbox
        ? 'https://api-sandbox.asaas.com/v3'
        : 'https://api.asaas.com/v3';

    // Onda 18.x — sandbox reflete a base URL EFETIVA (o setup por tenant grava
    // ASAAS_BASE_URL). Assim uma clinica em producao mostra "Producao" mesmo
    // que o flag global (asaas_sandbox) ainda esteja em sandbox.
    const sandbox = baseUrl.includes('sandbox');

    this.logger.debug(`[ASAAS] Config (tenant=${tenantId || 'global'}): baseUrl=${baseUrl}, apiKey=${apiKey ? `${apiKey.slice(0, 10)}...` : 'NAO CONFIGURADA'}`);

    return { apiKey: apiKey || '', baseUrl, sandbox, webhookToken: webhookToken || '' };
  }

  // ─── Core HTTP wrapper ─────────────────────────────────

  /**
   * Onda 17.32.82 — Propaga tenantId pro getConfig. Quando passado,
   * usa a conta Asaas DO TENANT (TenantSetting). Caller (PaymentGatewayService)
   * deve sempre passar o tenantId da operacao quando disponivel.
   */
  private async request<T>(
    method: string,
    path: string,
    data?: any,
    params?: any,
    tenantId?: string | null,
  ): Promise<T> {
    const config = await this.getConfig(tenantId);
    if (!config.apiKey) {
      // Onda 18.x — clínica sem gateway Asaas configurado (ou bloqueada pelo
      // isolamento por tenant). Erro LIMPO 503, não Error cru → não vira "erro
      // interno / 500". A venda rápida mostra a mensagem em vez de crashar.
      throw new ServiceUnavailableException(
        'Cobrança Asaas não está configurada para esta clínica. Configure a conta Asaas da clínica no cadastro do gateway (ou use recebimento na clínica assim que o suporte habilitar).',
      );
    }

    const url = `${config.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.logger.debug(
          `[ASAAS] ${method.toUpperCase()} ${path} (tentativa ${attempt}/${this.MAX_RETRIES})`,
        );

        const response = await axios({
          method,
          url,
          data,
          params,
          headers: {
            access_token: config.apiKey,
            'Content-Type': 'application/json',
            'User-Agent': 'LexCRM/1.0',  // Obrigatório desde Nov/2024
          },
          // Onda 17.8 — 20s (era 30s). Combinado com MAX_RETRIES=2,
          // pior caso 41s. Asaas raramente excede 5s no caminho feliz.
          timeout: 20000,
        });

        this.logger.debug(
          `[ASAAS] Resposta ${response.status} para ${method.toUpperCase()} ${path}`,
        );

        return response.data as T;
      } catch (err) {
        const axiosErr = err as AxiosError<any>;
        const status = axiosErr.response?.status;
        const asaasErrors = axiosErr.response?.data?.errors;

        // Nao retentar erros de validacao (4xx)
        if (status && status >= 400 && status < 500) {
          const errorMsg = asaasErrors?.length
            ? asaasErrors.map((e: any) => `${e.code}: ${e.description}`).join('; ')
            : axiosErr.message;
          throw new Error(`[Asaas ${status}] ${errorMsg}`);
        }

        lastError = new Error(
          `[Asaas] Falha na tentativa ${attempt}: ${axiosErr.message}`,
        );
        this.logger.warn(lastError.message);

        // Backoff exponencial apenas para erros de rede / 5xx
        if (attempt < this.MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 500;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('[Asaas] Erro desconhecido apos retentativas');
  }

  // ─── Customers ─────────────────────────────────────────

  // Onda 17.32.82 — Todos os metodos publicos aceitam tenantId opcional.
  // Caller (PaymentGatewayService) passa o tenantId da operacao pra que
  // cada tenant use sua propria conta Asaas. Sem tenantId, usa global.

  async createCustomer(data: CreateCustomerData, tenantId?: string | null): Promise<any> {
    return this.request<any>('POST', '/customers', data, undefined, tenantId);
  }

  async getCustomer(customerId: string, tenantId?: string | null): Promise<any> {
    return this.request<any>('GET', `/customers/${customerId}`, undefined, undefined, tenantId);
  }

  // ─── Charges (Payments) ────────────────────────────────

  async createCharge(data: CreateChargeData, tenantId?: string | null): Promise<any> {
    return this.request<any>('POST', '/payments', data, undefined, tenantId);
  }

  async getCharge(chargeId: string, tenantId?: string | null): Promise<any> {
    return this.request<any>('GET', `/payments/${chargeId}`, undefined, undefined, tenantId);
  }

  async getPixQrCode(chargeId: string, tenantId?: string | null): Promise<any> {
    return this.request<any>('GET', `/payments/${chargeId}/pixQrCode`, undefined, undefined, tenantId);
  }

  async updateCharge(chargeId: string, data: { value?: number; dueDate?: string; description?: string }, tenantId?: string | null): Promise<any> {
    return this.request<any>('PUT', `/payments/${chargeId}`, data, undefined, tenantId);
  }

  async getBalance(tenantId?: string | null): Promise<any> {
    return this.request<any>('GET', '/finance/balance', undefined, undefined, tenantId);
  }

  async receiveInCash(chargeId: string, paymentDate: string, value: number, tenantId?: string | null): Promise<any> {
    return this.request<any>('POST', `/payments/${chargeId}/receiveInCash`, {
      paymentDate,
      value,
    }, undefined, tenantId);
  }

  async deleteCharge(chargeId: string, tenantId?: string | null): Promise<any> {
    return this.request<any>('DELETE', `/payments/${chargeId}`, undefined, undefined, tenantId);
  }

  async listCharges(params?: any, tenantId?: string | null): Promise<any> {
    return this.request<any>('GET', '/payments', undefined, params, tenantId);
  }

  // ─── Customers List ───────────────────────────────────────

  async listCustomers(params?: {
    name?: string;
    email?: string;
    cpfCnpj?: string;
    externalReference?: string;
    offset?: number;
    limit?: number;
  }, tenantId?: string | null): Promise<any> {
    return this.request<any>('GET', '/customers', undefined, params, tenantId);
  }
}
