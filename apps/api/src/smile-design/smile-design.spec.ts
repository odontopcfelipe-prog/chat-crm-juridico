import {
  OpenAiImageProvider, buildModelChain, friendlyOpenAiError, isModelUnavailable, qualityForModel,
} from './image-provider';
import { buildSmilePrompt } from './smile-prompt';
import { openAiSizeFor, parseRegion, readPngSize } from './smile-image.util';

function fakePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe('smile-prompt', () => {
  it('manda mexer só nos dentes e manter o rosto', () => {
    const p = buildSmilePrompt({ treatment: 'COMPLETO', shade: 'NATURAL', hasMask: true });
    expect(p).toContain('Edit ONLY the teeth inside the masked mouth area');
    expect(p).toContain('same person and facial identity');
    expect(p).toContain('porcelain veneers');
    expect(p).toContain('shade A1');
  });

  it('clareamento não mexe no formato dos dentes', () => {
    const p = buildSmilePrompt({ treatment: 'CLAREAMENTO', shade: 'BRANCO', hasMask: false });
    expect(p).toContain('Do NOT change the shape');
    expect(p).toContain('shade BL2');
    expect(p).not.toContain('masked mouth area');
  });

  it('inclui o pedido do dentista e ignora pedido vazio', () => {
    expect(buildSmilePrompt({ treatment: 'ALINHAMENTO', shade: 'EXTRA', hasMask: true, extra: 'fechar diastema' }))
      .toContain('"fechar diastema"');
    expect(buildSmilePrompt({ treatment: 'ALINHAMENTO', shade: 'EXTRA', hasMask: true, extra: '   ' }))
      .not.toContain('Additional request');
  });
});

describe('smile-image.util', () => {
  it('lê o tamanho do PNG pelo cabeçalho', () => {
    expect(readPngSize(fakePng(1152, 1536))).toEqual({ width: 1152, height: 1536 });
    expect(readPngSize(Buffer.from('nao-e-png-nao-e-png-nao-e-png'))).toBeNull();
    expect(readPngSize(null)).toBeNull();
  });

  it('só aceita tamanho livre dentro das regras da OpenAI', () => {
    expect(openAiSizeFor(1152, 1536)).toBe('1152x1536');
    expect(openAiSizeFor(1536, 512)).toBe('1536x512');
    expect(openAiSizeFor(1150, 1536)).toBeNull(); // não múltiplo de 16
    expect(openAiSizeFor(640, 640)).toBeNull(); // menos de 655.360 px
    expect(openAiSizeFor(1600, 512)).toBeNull(); // proporção > 3:1
    expect(openAiSizeFor(4096, 2304)).toBeNull(); // lado > 3840
  });

  it('valida a elipse da boca', () => {
    expect(parseRegion('{"cx":0.5,"cy":0.6,"rx":0.2,"ry":0.1}')).toEqual({ cx: 0.5, cy: 0.6, rx: 0.2, ry: 0.1 });
    expect(parseRegion('{"cx":2,"cy":0.6,"rx":0.2,"ry":0.1}')).toBeNull();
    expect(parseRegion('lixo')).toBeNull();
    expect(parseRegion('')).toBeNull();
    expect(parseRegion(undefined)).toBeNull();
  });
});

describe('image-provider', () => {
  it('cadeia de modelos começa pelo mais novo e respeita o forçado', () => {
    expect(buildModelChain()[0]).toBe('gpt-image-2.5-sunburst');
    const forced = buildModelChain('gpt-image-2');
    expect(forced[0]).toBe('gpt-image-2');
    expect(forced.filter((m) => m === 'gpt-image-2')).toHaveLength(1);
  });

  it('ajusta a qualidade por modelo', () => {
    expect(qualityForModel('gpt-image-2.5-sunburst', 'high')).toBe('high');
    expect(qualityForModel('gpt-image-2.5-flare', 'max')).toBe('max');
    expect(qualityForModel('gpt-image-2', 'high')).toBe('medium');
    expect(qualityForModel('gpt-image-1.5', 'max')).toBe('high');
    expect(qualityForModel('gpt-image-2.5-sunburst', 'qualquer')).toBe('high');
  });

  it('distingue modelo indisponível de conta não verificada', () => {
    expect(isModelUnavailable(404, 'model_not_found', 'The model `x` does not exist')).toBe(true);
    expect(isModelUnavailable(400, '', "Invalid value: 'gpt-image-2.5-sunburst'. Supported values for model are ...")).toBe(true);
    expect(isModelUnavailable(403, '', 'Your organization must be verified to use the model `gpt-image-2.5-sunburst`')).toBe(false);
    expect(isModelUnavailable(400, '', 'Your request was rejected by the safety system')).toBe(false);
  });

  it('traduz os erros comuns da OpenAI', () => {
    expect(friendlyOpenAiError(401, '', 'bad key')).toContain('Chave da OpenAI inválida');
    expect(friendlyOpenAiError(403, '', 'organization must be verified')).toContain('Verify Organization');
    expect(friendlyOpenAiError(429, 'insufficient_quota', 'quota')).toContain('sem crédito');
    expect(friendlyOpenAiError(400, 'moderation_blocked', 'blocked')).toContain('filtro de segurança');
  });

  describe('OpenAiImageProvider', () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    it('cai pro próximo modelo quando o primeiro não existe e manda os campos certos', async () => {
      const calls: FormData[] = [];
      global.fetch = jest.fn(async (_url: any, init: any) => {
        calls.push(init.body as FormData);
        if (calls.length === 1) {
          return new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'The model does not exist' } }), { status: 404 });
        }
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from('imagem').toString('base64') }],
          output_format: 'jpeg', size: '1152x1536', quality: 'high',
        }), { status: 200 });
      }) as any;

      const provider = new OpenAiImageProvider('sk-test', ['modelo-x', 'gpt-image-2.5-flare'], 'high');
      const res = await provider.generate({
        before: fakePng(1152, 1536), beforeMime: 'image/png', mask: fakePng(1152, 1536),
        prompt: 'teste', size: '1152x1536',
      });

      expect(res.buffer.toString()).toBe('imagem');
      expect(res.mime).toBe('image/jpeg');
      expect(res.metadata.model).toBe('gpt-image-2.5-flare');
      const sent = calls[1];
      expect(sent.get('model')).toBe('gpt-image-2.5-flare');
      expect(sent.get('size')).toBe('1152x1536');
      expect(sent.get('input_fidelity')).toBeNull(); // 2.x recusa o parâmetro
      expect(sent.get('mask')).not.toBeNull();
    });

    it('conta não verificada para na hora com mensagem clara', async () => {
      global.fetch = jest.fn(async () => new Response(
        JSON.stringify({ error: { message: 'Your organization must be verified to use the model' } }), { status: 403 },
      )) as any;
      const provider = new OpenAiImageProvider('sk-test', ['gpt-image-2.5-sunburst', 'gpt-image-2'], 'high');
      await expect(provider.generate({ before: fakePng(1024, 1024), beforeMime: 'image/png', prompt: 'x' }))
        .rejects.toThrow('Verify Organization');
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    });

    it('gpt-image-1.5 usa size auto e alta fidelidade', async () => {
      let sent: FormData | null = null;
      global.fetch = jest.fn(async (_u: any, init: any) => {
        sent = init.body;
        return new Response(JSON.stringify({ data: [{ b64_json: 'aGk=' }] }), { status: 200 });
      }) as any;
      const provider = new OpenAiImageProvider('sk-test', ['gpt-image-1.5'], 'high');
      await provider.generate({ before: fakePng(1152, 1536), beforeMime: 'image/png', prompt: 'x', size: '1152x1536' });
      expect(sent!.get('size')).toBe('auto');
      expect(sent!.get('input_fidelity')).toBe('high');
    });
  });
});
