/**
 * Abstracao de provider de geracao de imagem para Smile/Face Design.
 *
 * Implementacoes possiveis:
 *  - mock (default): retorna a foto original (placeholder)
 *  - replicate: API do Replicate (modelos publicos)
 *  - fal: API do fal.ai (mais barato, mais rapido para SD)
 *  - stability: Stability AI direto
 *  - openai_image: OpenAI gpt-image-1 (caro mas qualidade alta para edicao)
 *  - custom: webhook para modelo proprio
 *
 * Cada provider concreto recebe a foto original (Buffer) + prompt
 * + tipo de simulacao e retorna o Buffer da imagem gerada (PNG/JPEG).
 */

import { Logger } from '@nestjs/common';

export interface ImageGenerationParams {
  before: Buffer;
  beforeMime: string;
  simulationType: string; // SMILE | FACE_HARMONY | LIPS | RHINOMODULATION | OTHER
  prompt?: string;
  providerKey?: string;
  providerEndpoint?: string;
}

export interface ImageGenerationResult {
  buffer: Buffer;
  mime: string;
  metadata: any;
}

export interface ImageProvider {
  name: string;
  generate(params: ImageGenerationParams): Promise<ImageGenerationResult>;
}

/**
 * MockProvider: devolve a foto original. Usado quando nenhum provider
 * real esta configurado. UI mostra disclaimer 'simulacao mock'.
 */
export class MockImageProvider implements ImageProvider {
  name = 'mock';
  private logger = new Logger('MockImageProvider');

  async generate(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    this.logger.warn(
      '[MOCK] Sem provider real configurado — devolvendo foto original como simulacao. ' +
      'Configure SMILE_DESIGN_PROVIDER em GlobalSetting para ativar IA real.',
    );
    return {
      buffer: params.before,
      mime: params.beforeMime,
      metadata: {
        provider: 'mock',
        note: 'Foto original devolvida — provider real nao configurado',
        simulation_type: params.simulationType,
        prompt: params.prompt,
      },
    };
  }
}

/**
 * Factory simples — retorna o provider configurado ou mock.
 * No futuro: ler de GlobalSetting (SMILE_DESIGN_PROVIDER) e instanciar
 * o provider real (Replicate/fal/etc.) com endpoint+key.
 */
export function getImageProvider(name?: string): ImageProvider {
  // Por enquanto, sempre retorna mock. Plug providers reais aqui:
  // if (name === 'replicate') return new ReplicateProvider();
  // if (name === 'fal')       return new FalProvider();
  // ...
  return new MockImageProvider();
}
