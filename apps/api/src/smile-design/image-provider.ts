/**
 * Provider de geração de imagem do Smile Design.
 *
 *  - openai (padrão): Image API da OpenAI (`/v1/images/edits`) com o modelo de
 *    edição mais novo. Usa a MESMA chave global da IA (Ajustes › IA) — não
 *    precisa de conta nova. Sem chave = erro claro (não finge que gerou).
 *  - mock: devolve a foto original. Só quando forçado (SMILE_DESIGN_PROVIDER=mock),
 *    pra desenvolvimento sem gastar crédito.
 *
 * Configuráveis em GlobalSetting (opcionais):
 *  - SMILE_DESIGN_MODEL   — força um modelo (vai na frente da cadeia de fallback)
 *  - SMILE_DESIGN_QUALITY — low | medium | high (padrão) | xhigh | max
 */

import { Logger } from '@nestjs/common';

export interface ImageGenerationParams {
  before: Buffer;
  beforeMime: string;
  /** PNG do mesmo tamanho da foto; área TRANSPARENTE = onde a IA pode mexer. */
  mask?: Buffer | null;
  prompt: string;
  /** 'LARGURAxALTURA' (múltiplos de 16) — só a família gpt-image-2 aceita tamanho livre. */
  size?: string | null;
}

export interface ImageGenerationResult {
  buffer: Buffer;
  mime: string;
  metadata: Record<string, any>;
}

export interface ImageProvider {
  name: string;
  generate(params: ImageGenerationParams): Promise<ImageGenerationResult>;
}

/**
 * Do mais novo/preciso pro mais antigo. Se a conta ainda não tiver acesso a um
 * modelo, cai pro próximo (o resultado registra qual modelo gerou).
 *  - gpt-image-2.5-sunburst (set/2026): o de edição mais precisa
 *  - gpt-image-2.5-flare: mesma geração, mais rápido
 *  - gpt-image-2 (abr/2026) e gpt-image-1.5: rede de segurança
 */
export const SMILE_MODEL_CHAIN = [
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2',
  'gpt-image-1.5',
];

export function buildModelChain(preferred?: string | null): string[] {
  const p = (preferred || '').trim();
  if (!p) return [...SMILE_MODEL_CHAIN];
  return [p, ...SMILE_MODEL_CHAIN.filter((m) => m !== p)];
}

const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * O "high" do 2.5 equivale ao "medium" do gpt-image-2 (mesmo volume de tokens,
 * e o high do 2 leva ~4 min). xhigh/max só existem no 2.5.
 */
export function qualityForModel(model: string, wanted: string): string {
  const q = QUALITIES.includes(wanted) ? wanted : 'high';
  if (model.startsWith('gpt-image-2.5')) return q;
  if (model.startsWith('gpt-image-2')) {
    if (q === 'max' || q === 'xhigh') return 'high';
    if (q === 'high') return 'medium';
    return q;
  }
  return q === 'xhigh' || q === 'max' ? 'high' : q;
}

/** Erro de "este modelo não está disponível pra esta conta" → tenta o próximo. */
class ModelUnavailableError extends Error {}

export class MockImageProvider implements ImageProvider {
  name = 'mock';
  private logger = new Logger('MockImageProvider');

  async generate(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    this.logger.warn('[MOCK] SMILE_DESIGN_PROVIDER=mock — devolvendo a foto original.');
    return {
      buffer: params.before,
      mime: params.beforeMime,
      metadata: { provider: 'mock', note: 'Foto original devolvida (modo de teste)' },
    };
  }
}

export class OpenAiImageProvider implements ImageProvider {
  name = 'openai';
  private logger = new Logger('OpenAiImageProvider');

  constructor(
    private readonly apiKey: string,
    private readonly models: string[],
    private readonly quality: string,
  ) {}

  async generate(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    let lastErr: Error | null = null;
    for (const model of this.models) {
      try {
        return await this.callModel(model, params);
      } catch (e: any) {
        if (e instanceof ModelUnavailableError) {
          this.logger.warn(`[SmileDesign] modelo ${model} indisponível (${e.message}) — tentando o próximo`);
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw new Error(
      `Nenhum modelo de imagem da OpenAI está liberado para esta conta (${lastErr?.message || 'sem detalhe'})`,
    );
  }

  private async callModel(model: string, p: ImageGenerationParams): Promise<ImageGenerationResult> {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', p.prompt);
    const ext = (p.beforeMime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    form.append('image', new Blob([new Uint8Array(p.before)], { type: p.beforeMime }), `foto.${ext}`);
    if (p.mask) {
      form.append('mask', new Blob([new Uint8Array(p.mask)], { type: 'image/png' }), 'mascara.png');
    }
    form.append('n', '1');
    const customSize = model.startsWith('gpt-image-2') && !!p.size && /^\d+x\d+$/.test(p.size);
    form.append('size', customSize ? (p.size as string) : 'auto');
    form.append('quality', qualityForModel(model, this.quality));
    form.append('output_format', 'jpeg');
    form.append('output_compression', '92');
    // gpt-image-2+ já processa a foto em alta fidelidade e RECUSA o parâmetro.
    if (model.startsWith('gpt-image-1')) form.append('input_fidelity', 'high');

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(6 * 60_000),
      });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new Error('A IA demorou demais para responder — tente de novo.');
      }
      throw new Error(`Falha de conexão com a OpenAI: ${e?.message || e}`);
    }

    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* corpo não-JSON */ }

    if (!res.ok) {
      const msg: string = json?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
      const code: string = json?.error?.code || '';
      if (isModelUnavailable(res.status, code, msg)) throw new ModelUnavailableError(`${res.status} ${msg}`);
      throw new Error(friendlyOpenAiError(res.status, code, msg));
    }

    const b64: string | undefined = json?.data?.[0]?.b64_json;
    if (!b64) throw new Error('A IA respondeu sem imagem — tente de novo.');
    const fmt = json?.output_format === 'png' || json?.output_format === 'webp' ? json.output_format : 'jpeg';
    return {
      buffer: Buffer.from(b64, 'base64'),
      mime: `image/${fmt}`,
      metadata: {
        provider: 'openai',
        model,
        size: json?.size ?? null,
        quality: json?.quality ?? null,
        usage: json?.usage ?? null,
        duration_ms: Date.now() - startedAt,
      },
    };
  }
}

export function isModelUnavailable(status: number, code: string, msg: string): boolean {
  // Conta não verificada vale pra TODOS os modelos de imagem — não adianta trocar.
  if (/verif/i.test(msg)) return false;
  if (code === 'model_not_found') return true;
  if (!/model/i.test(msg)) return false;
  return status === 404 || /does not exist|not found|invalid value|not supported|unsupported|do not have access|does not have access/i.test(msg);
}

export function friendlyOpenAiError(status: number, code: string, msg: string): string {
  if (status === 401) return 'Chave da OpenAI inválida — confira em Ajustes › IA.';
  if (/verif/i.test(msg)) {
    return 'A conta da OpenAI precisa ser verificada para gerar imagens: entre em ' +
      'platform.openai.com/settings/organization/general e clique em "Verify Organization" ' +
      '(libera em até 15 minutos).';
  }
  if (code === 'insufficient_quota' || /quota|billing/i.test(msg)) {
    return 'A conta da OpenAI está sem crédito — recarregue o saldo em platform.openai.com.';
  }
  if (status === 429) return 'Muitas simulações ao mesmo tempo na OpenAI — tente de novo em 1 minuto.';
  if (code === 'moderation_blocked' || /safety|moderation/i.test(msg)) {
    return 'A IA recusou esta foto pelo filtro de segurança. Tente outra foto (rosto de frente, boa luz).';
  }
  if (status >= 500) return 'A OpenAI está instável agora — tente de novo em alguns minutos.';
  return `A OpenAI recusou o pedido: ${msg.slice(0, 240)}`;
}
