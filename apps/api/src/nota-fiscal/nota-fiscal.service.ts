import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { isLabTenant } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { soDoLaboratorio } from '../common/lab-gate.util';
import { clinicSettingStorageKey, validarValorChaveClinica } from '../settings/settings-scope';
import { LAB_NFSE } from './lab-nota-fiscal-textos';

@Injectable()
export class NotaFiscalService {
  private readonly logger = new Logger(NotaFiscalService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  /**
   * Config de NFS-e é POR CONTA: `nfse_*_<tenantId>` na GlobalSetting (gravada pela
   * tela Nota Fiscal via PUT /settings). Sem reserva na chave global antiga: cada
   * clínica tem o seu CNPJ, inscrição e chave, e a emissão é simulada. Sem conta,
   * nada configurado.
   */
  private nfse(key: string, tenantId?: string | null): Promise<string | null> {
    if (!tenantId) return Promise.resolve(null);
    return this.settings.get(`${key}_${tenantId}`);
  }

  // ─── List NFs ──────────────────────────────────────────

  async findAll(query: {
    tenantId?: string;
    leadId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};

    if (query.tenantId) where.tenant_id = query.tenantId;
    if (query.leadId) where.lead_id = query.leadId;
    if (query.status) where.status = query.status;

    const [data, total] = await Promise.all([
      this.prisma.notaFiscal.findMany({
        where,
        include: {
          transaction: {
            select: {
              id: true,
              description: true,
              amount: true,
              status: true,
              category: true,
            },
          },
          lead: {
            select: { id: true, name: true, phone: true, email: true },
          },
        },
        orderBy: { created_at: 'desc' },
        take: query.limit || 50,
        skip: query.offset || 0,
      }),
      this.prisma.notaFiscal.count({ where }),
    ]);

    return { data, total };
  }

  // ─── Get single NF ────────────────────────────────────

  async findOne(id: string, tenantId?: string) {
    const nf = await this.prisma.notaFiscal.findUnique({
      where: { id },
      include: {
        transaction: {
          select: {
            id: true,
            description: true,
            amount: true,
            status: true,
            category: true,
            date: true,
            payment_method: true,
          },
        },
        lead: {
          select: { id: true, name: true, phone: true, email: true },
        },
      },
    });

    if (!nf) throw new NotFoundException('Nota fiscal nao encontrada');
    // Com conta no contexto, só a nota da própria conta; nota sem conta (tenant_id
    // NULL) também é recusada. SUPER_ADMIN chega sem conta e continua lendo qualquer uma.
    if (tenantId && nf.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }

    return nf;
  }

  // ─── Emit NFS-e ───────────────────────────────────────

  async emit(transactionId: string, tenantId?: string) {
    // 1. Fetch transaction with lead data
    const transaction = await this.prisma.financialTransaction.findUnique({
      where: { id: transactionId },
      include: {
        lead: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
      },
    });

    if (!transaction) throw new NotFoundException('Transacao financeira nao encontrada');
    // Mesma regra do findOne: transação de outra conta ou sem conta é recusada
    // antes de ler a configuração de NFS-e ou gravar a nota.
    if (tenantId && transaction.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a esta transacao');
    }

    // 2. Idempotent check — if NF already exists for this transaction, return it
    const existing = await this.prisma.notaFiscal.findUnique({
      where: { transaction_id: transactionId },
    });
    if (existing) {
      this.logger.warn(`NF ja existe para transacao ${transactionId}, retornando existente`);
      return existing;
    }

    // 3. Config de NFS-e DA CONTA da transação (SUPER_ADMIN sem conta chega com
    // tenantId undefined: vale a conta da própria transação).
    const conta = tenantId || transaction.tenant_id || null;
    const [provider, apiKey, cnpj, inscricaoMunicipal, cnaeCode, issRate, servicoDescricao] =
      await Promise.all([
        this.nfse('nfse_provider', conta),
        this.nfse('nfse_api_key', conta),
        this.nfse('nfse_cnpj', conta),
        this.nfse('nfse_inscricao_municipal', conta),
        this.nfse('nfse_cnae_code', conta),
        this.nfse('nfse_default_iss_rate', conta),
        this.nfse('nfse_servico_descricao', conta),
      ]);

    if (!provider || !apiKey) {
      throw new BadRequestException(
        'Configuracao de NFS-e incompleta. Configure provider e api_key nas configuracoes.',
      );
    }

    // Laboratório: sem valor de reserva — o código do serviço (CNAE), a alíquota e o
    // CNPJ são os que o laboratório preencheu; a descrição padrão é a dele.
    const lab = await isLabTenant(this.prisma, conta, (m) => this.logger.warn(m));
    if (lab && (!cnpj || !cnaeCode || !issRate)) {
      throw new BadRequestException(LAB_NFSE.faltaDados);
    }

    const resolvedCnae = cnaeCode || '6911-7/01';
    const resolvedIss = issRate || '5.00';
    const resolvedDescricao = servicoDescricao || (lab ? LAB_NFSE.descricaoPadrao : 'Servicos advocaticios');

    const lead = (transaction as any).lead;
    const valor = Number(transaction.amount);
    const aliquotaIss = parseFloat(resolvedIss);
    const valorIss = Math.round(valor * (aliquotaIss / 100) * 100) / 100;

    // 4. Build NFS-e payload
    const payload = {
      prestador: {
        cnpj: cnpj,
        inscricao_municipal: inscricaoMunicipal,
      },
      tomador: {
        cpf_cnpj: lead?.cpf || null,
        razao_social: lead?.name || 'Consumidor Final',
        email: lead?.email || null,
      },
      servico: {
        codigo_cnae: resolvedCnae,
        descricao: resolvedDescricao,
        valor_servicos: valor,
        aliquota_iss: aliquotaIss,
        valor_iss: valorIss,
      },
    };

    // 5. Call provider API
    const providerResponse = await this.callProviderApi(
      provider.toUpperCase(),
      apiKey,
      payload,
    );

    // 6. Store result in NotaFiscal
    const nf = await this.prisma.notaFiscal.create({
      data: {
        tenant_id: tenantId || transaction.tenant_id || null,
        transaction_id: transactionId,
        lead_id: transaction.lead_id || null,
        numero: providerResponse.numero || null,
        codigo_verificacao: providerResponse.codigo_verificacao || null,
        status: providerResponse.success ? 'EMITIDA' : 'ERRO',
        servico_codigo: resolvedCnae,
        servico_descricao: resolvedDescricao,
        valor: valor,
        aliquota_iss: aliquotaIss,
        valor_iss: valorIss,
        tomador_cpf_cnpj: lead?.cpf || null,
        tomador_nome: lead?.name || null,
        tomador_email: lead?.email || null,
        provider: provider.toUpperCase(),
        external_id: providerResponse.external_id || null,
        xml_url: providerResponse.xml_url || null,
        pdf_url: providerResponse.pdf_url || null,
        error_message: providerResponse.error_message || null,
        emitida_em: providerResponse.success ? new Date() : null,
      },
    });

    this.logger.log(`NF ${nf.id} criada para transacao ${transactionId} — status: ${nf.status}`);

    return nf;
  }

  // ─── Cancel NFS-e ─────────────────────────────────────

  async cancel(id: string, tenantId?: string) {
    const nf = await this.prisma.notaFiscal.findUnique({ where: { id } });
    if (!nf) throw new NotFoundException('Nota fiscal nao encontrada');
    // Mesma regra do findOne: nota de outra conta ou sem conta é recusada.
    if (tenantId && nf.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }
    if (nf.status === 'CANCELADA') {
      throw new ConflictException('Nota fiscal ja esta cancelada');
    }
    if (nf.status !== 'EMITIDA') {
      throw new BadRequestException('Somente notas emitidas podem ser canceladas');
    }

    // TODO: Call provider API to cancel the NFS-e on the provider side
    this.logger.warn(`Cancelamento de NF ${id} no provider ${nf.provider} — implementar integracao real`);

    return this.prisma.notaFiscal.update({
      where: { id },
      data: {
        status: 'CANCELADA',
        cancelada_em: new Date(),
      },
    });
  }

  // ─── Get NFS-e config status ──────────────────────────

  async getConfig(tenantId?: string) {
    const [provider, apiKey, cnpj, inscricaoMunicipal, cnaeCode, issRate, autoEmit, servicoDescricao] =
      await Promise.all([
        this.nfse('nfse_provider', tenantId),
        this.nfse('nfse_api_key', tenantId),
        this.nfse('nfse_cnpj', tenantId),
        this.nfse('nfse_inscricao_municipal', tenantId),
        this.nfse('nfse_cnae_code', tenantId),
        this.nfse('nfse_default_iss_rate', tenantId),
        this.nfse('nfse_auto_emit', tenantId),
        this.nfse('nfse_servico_descricao', tenantId),
      ]);

    // Laboratório: o que ele não preencheu volta vazio (sem CNAE nem alíquota de reserva)
    // e a descrição padrão é a do laboratório.
    const lab = await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
    return {
      configured: !!(provider && apiKey && cnpj),
      provider: provider || null,
      has_api_key: !!apiKey,
      cnpj: cnpj || null,
      inscricao_municipal: inscricaoMunicipal || null,
      cnae_code: cnaeCode || (lab ? null : '6911-7/01'),
      default_iss_rate: issRate || (lab ? null : '5.00'),
      auto_emit: autoEmit === 'true',
      servico_descricao: servicoDescricao || (lab ? LAB_NFSE.descricaoPadrao : 'Servicos advocaticios'),
    };
  }

  // ─── Salvar a configuração (laboratório) ──────────────

  /**
   * Grava a configuração de NFS-e DA CONTA do laboratório (`nfse_*_<conta>`, a mesma
   * chave que a leitura usa). A clínica continua gravando pela tela, em PUT /settings;
   * este caminho é só do laboratório. Chave da API em branco = manter a atual.
   */
  async saveConfigLab(
    tenantId: string,
    body: {
      provider?: string;
      api_key?: string;
      cnpj?: string;
      inscricao_municipal?: string;
      cnae_code?: string;
      default_iss_rate?: string;
      auto_emit?: boolean;
      servico_descricao?: string;
    },
  ) {
    if (!tenantId || !(await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m)))) {
      throw soDoLaboratorio();
    }
    const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const provider = texto(body.provider).toLowerCase();
    if (provider && !['enotas', 'nfeio', 'focusnfe'].includes(provider)) {
      throw new BadRequestException(LAB_NFSE.provedorInvalido);
    }
    const cnpj = texto(body.cnpj).replace(/\D/g, '');
    if (cnpj && cnpj.length !== 14) throw new BadRequestException(LAB_NFSE.cnpjInvalido);
    const aliquota = texto(body.default_iss_rate).replace(',', '.');
    if (aliquota) {
      const n = Number(aliquota);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequestException(LAB_NFSE.aliquotaInvalida);
    }
    const pares: Array<[string, string]> = [
      ['nfse_provider', provider],
      ['nfse_cnpj', cnpj],
      ['nfse_inscricao_municipal', texto(body.inscricao_municipal)],
      ['nfse_cnae_code', texto(body.cnae_code)],
      ['nfse_default_iss_rate', aliquota],
      ['nfse_auto_emit', body.auto_emit === true ? 'true' : 'false'],
      ['nfse_servico_descricao', texto(body.servico_descricao)],
    ];
    const chave = texto(body.api_key);
    if (chave) pares.push(['nfse_api_key', chave]);
    for (const [k, v] of pares) {
      if (v.length > 500) throw new BadRequestException(LAB_NFSE.valorLongoDemais(k));
      await this.settings.upsert(clinicSettingStorageKey(k, tenantId), validarValorChaveClinica(k, v));
    }
    return this.getConfig(tenantId);
  }

  // ─── Auto-emit if enabled ─────────────────────────────

  async autoEmitIfEnabled(transactionId: string, tenantId?: string) {
    const conta =
      tenantId ||
      (await this.prisma.financialTransaction.findUnique({ where: { id: transactionId }, select: { tenant_id: true } }))
        ?.tenant_id ||
      null;
    const autoEmit = await this.nfse('nfse_auto_emit', conta);
    if (autoEmit !== 'true') {
      this.logger.debug('Auto-emissao de NFS-e desabilitada, pulando');
      return null;
    }

    this.logger.log(`Auto-emissao habilitada, emitindo NF para transacao ${transactionId}`);
    return this.emit(transactionId, tenantId);
  }

  // ─── Provider API call (placeholder) ──────────────────

  /**
   * TODO: A integracao real depende do provider escolhido pelo usuario.
   * Providers suportados: ENOTAS, NFEIO, FOCUSNFE
   * Cada provider tem sua propria API e formato de payload.
   * Este metodo deve ser substituido pela integracao real quando o
   * provider for definido.
   */
  private async callProviderApi(
    provider: string,
    apiKey: string,
    payload: any,
  ): Promise<{
    success: boolean;
    numero?: string;
    codigo_verificacao?: string;
    external_id?: string;
    xml_url?: string;
    pdf_url?: string;
    error_message?: string;
  }> {
    this.logger.log(`[MOCK] Chamando provider ${provider} para emissao de NFS-e`);
    this.logger.log(`[MOCK] API Key: ${apiKey.substring(0, 4)}****`);
    this.logger.log(`[MOCK] Payload: ${JSON.stringify(payload, null, 2)}`);

    // TODO: Implementar chamada real com axios baseado no provider:
    //
    // if (provider === 'ENOTAS') {
    //   const response = await axios.post('https://api.enotas.com.br/v2/...', payload, {
    //     headers: { Authorization: `Bearer ${apiKey}` },
    //   });
    //   return { success: true, ...response.data };
    // }
    //
    // if (provider === 'NFEIO') {
    //   const response = await axios.post('https://api.nfe.io/v1/...', payload, {
    //     headers: { Authorization: apiKey },
    //   });
    //   return { success: true, ...response.data };
    // }
    //
    // if (provider === 'FOCUSNFE') {
    //   const response = await axios.post('https://api.focusnfe.com.br/v2/...', payload, {
    //     headers: { Authorization: `Token ${apiKey}` },
    //   });
    //   return { success: true, ...response.data };
    // }

    // Mock response for development
    const mockNumero = `NF${Date.now().toString().slice(-8)}`;
    const mockVerificacao = Math.random().toString(36).substring(2, 10).toUpperCase();

    return {
      success: true,
      numero: mockNumero,
      codigo_verificacao: mockVerificacao,
      external_id: `mock_${provider.toLowerCase()}_${Date.now()}`,
      xml_url: undefined,
      pdf_url: undefined,
      error_message: undefined,
    };
  }
}
