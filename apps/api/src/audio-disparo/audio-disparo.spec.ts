import { instrucaoRitmo, instrucaoVoz, normalizarAudioConfig, textoParaFala } from '@crm/shared';
import { AudioDisparoService, wavDePcm } from './audio-disparo.service';

describe('lembrete em áudio — regras', () => {
  it('normaliza: valor fora da lista volta ao padrão; voz troca junto com o motor', () => {
    expect(normalizarAudioConfig({})).toMatchObject({ motor: 'chatgpt', voz: 'marin', sotaque: 'neutro', velocidade: 1 });
    expect(normalizarAudioConfig({ motor: 'openai', voz: 'cedar' }).voz).toBe('cedar'); // marin/cedar também no leitor
    expect(normalizarAudioConfig({ motor: 'chatgpt', voz: 'fable' }).voz).toBe('marin'); // fable não existe na voz do ChatGPT
    expect(normalizarAudioConfig({ motor: 'gemini', voz: 'coral' }).voz).toBe('Kore'); // coral não é voz do Gemini
    expect(normalizarAudioConfig({ motor: 'gemini', voz: 'Sulafat' }).voz).toBe('Sulafat');
    expect(normalizarAudioConfig({ sotaque: 'nordestino', velocidade: 9 })).toMatchObject({ sotaque: 'nordestino', velocidade: 1.5 });
    expect(normalizarAudioConfig({ sotaque: 'marciano', velocidade: 0.1 })).toMatchObject({ sotaque: 'neutro', velocidade: 0.7 });
    expect(normalizarAudioConfig({ texto: 'x'.repeat(900) }).texto).toHaveLength(600);
  });

  it('instrução: atendente + sotaque + ritmo', () => {
    const i = instrucaoVoz({ sotaque: 'nordestino', velocidade: 0.8 });
    expect(i).toMatch(/clínica odontológica/);
    expect(i).toMatch(/Alagoas/);
    expect(i).toMatch(/devagar/);
    expect(instrucaoRitmo(1)).toMatch(/normal/);
    expect(instrucaoRitmo(1.3)).toMatch(/rápido/);
  });

  it('texto pra fala: variáveis, sem emoji/asterisco/quebra', () => {
    expect(textoParaFala('Oi, {nome}! 😊\n*Amanhã* às {hora} ✨', { nome: 'Ana', hora: '15:00' })).toBe('Oi, Ana! Amanhã às 15:00');
  });

  it('WAV: cabeçalho RIFF de 44 bytes + o PCM', () => {
    const w = wavDePcm(Buffer.alloc(480));
    expect(w.length).toBe(524);
    expect(w.toString('ascii', 0, 4)).toBe('RIFF');
    expect(w.readUInt32LE(24)).toBe(24000);
  });
});

describe('lembrete em áudio — serviço', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function svc(over: Partial<{ openaiKey: string | null; googleKey: string | null; chips: any[]; envio: any }> = {}) {
    const o = { openaiKey: 'sk-x', googleKey: 'g-x', chips: [{ name: 'fin', purpose: 'FINANCEIRO' }, { name: 'clin', purpose: 'CLINICA' }], envio: { key: { id: 'A' } }, ...over };
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ name: 'Instituto Teste' })) },
      user: { findFirst: jest.fn(async () => ({ name: 'Dra. Suellen' })) },
      instance: { findMany: jest.fn(async () => o.chips) },
      tenantSetting: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
    };
    const settings: any = { getAiConfig: jest.fn(async () => ({ apiKey: o.openaiKey })), get: jest.fn(async () => o.googleKey) };
    const whatsapp: any = { sendMedia: jest.fn(async () => o.envio) };
    return { s: new AudioDisparoService(prisma, settings, whatsapp), prisma, whatsapp };
  }
  const resp = (status: number, body: any, bin?: Buffer) => ({
    ok: status < 400, status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => {
      const b = bin || Buffer.from('mp3');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); // só os bytes (Buffer do Node usa memória compartilhada)
    },
  });

  it('OpenAI: voz, instrução de sotaque, velocidade e texto com os dados de exemplo da clínica', async () => {
    const f = jest.fn(async () => resp(200, null, Buffer.from('MP3DATA')));
    global.fetch = f as any;
    const { s } = svc();
    const a = await s.ouvir('T1', { motor: 'openai', voz: 'nova', sotaque: 'carioca', velocidade: 1.2, texto: 'Oi {nome}, aqui é da equipe {clinica}, com {dentista}.' });
    expect(a.mime).toBe('audio/mpeg');
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(init.headers.Authorization).toBe('Bearer sk-x');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'nova', speed: 1.2, response_format: 'mp3' });
    expect(body.instructions).toMatch(/carioca/);
    expect(body.input).toBe('Oi Felipe, aqui é da equipe Instituto Teste, com Dra. Suellen.');
  });

  it('voz do ChatGPT: gpt-audio-1.5 com saída em áudio, instrução de falar SÓ o texto', async () => {
    const mp3 = Buffer.from('MP3VOZ').toString('base64');
    const f = jest.fn(async () => resp(200, { choices: [{ message: { audio: { data: mp3, transcript: 'x' } } }] }));
    global.fetch = f as any;
    const a = await svc().s.ouvir('T1', { motor: 'chatgpt', voz: 'cedar', sotaque: 'nordestino', velocidade: 0.8 });
    expect(a).toEqual({ buffer: Buffer.from('MP3VOZ'), mime: 'audio/mpeg' });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'gpt-audio-1.5', modalities: ['text', 'audio'], audio: { voice: 'cedar', format: 'mp3' } });
    expect(body.messages[0].content).toMatch(/EXATAMENTE/);
    expect(body.messages[0].content).toMatch(/Alagoas/);
    expect(body.messages[0].content).toMatch(/devagar/);
    expect(body.messages[1].content).toMatch(/^"""Oi, Felipe! Aqui é da equipe Instituto Teste./);
  });

  it('voz do ChatGPT: modelo indisponível na conta → tenta o próximo; outro erro → para', async () => {
    const ok = resp(200, { choices: [{ message: { audio: { data: Buffer.from('A').toString('base64') } } }] });
    const f = jest.fn()
      .mockResolvedValueOnce(resp(404, { error: { message: 'The model `gpt-audio-1.5` does not exist' } }))
      .mockResolvedValueOnce(ok);
    global.fetch = f as any;
    await svc().s.ouvir('T1', { motor: 'chatgpt' });
    expect(JSON.parse((f.mock.calls[1] as any)[1].body).model).toBe('gpt-audio');
    const g = jest.fn(async () => resp(401, { error: { message: 'Incorrect API key' } }));
    global.fetch = g as any;
    await expect(svc().s.ouvir('T1', { motor: 'chatgpt' })).rejects.toThrow('recusou (401)');
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('OpenAI recusa o número de velocidade → tenta de novo só com a instrução', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(resp(400, { error: { message: "Unsupported parameter: 'speed'" } }))
      .mockResolvedValueOnce(resp(200, null));
    global.fetch = f as any;
    await svc().s.ouvir('T1', { motor: 'openai', velocidade: 0.8 });
    expect(JSON.parse((f.mock.calls[1] as any)[1].body).speed).toBeUndefined();
  });

  it('Gemini: voz escolhida + instrução no texto; devolve WAV', async () => {
    const pcm = Buffer.alloc(100).toString('base64');
    const f = jest.fn(async () => resp(200, { candidates: [{ content: { parts: [{ inlineData: { data: pcm } }] } }] }));
    global.fetch = f as any;
    const a = await svc().s.ouvir('T1', { motor: 'gemini', voz: 'Sulafat', sotaque: 'mineiro' });
    expect(a.mime).toBe('audio/wav');
    expect(a.buffer.toString('ascii', 0, 4)).toBe('RIFF');
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toContain('gemini-2.5-flash-preview-tts:generateContent?key=g-x');
    const body = JSON.parse(init.body);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Sulafat');
    expect(body.contents[0].parts[0].text).toMatch(/mineiro.*Agora diga: Oi, Felipe!/s);
  });

  it('sem chave do motor → erro claro (não chama ninguém)', async () => {
    const f = jest.fn();
    global.fetch = f as any;
    await expect(svc({ openaiKey: null }).s.ouvir('T1', { motor: 'openai' })).rejects.toThrow(/OpenAI não configurada/);
    await expect(svc({ googleKey: null }).s.ouvir('T1', { motor: 'gemini' })).rejects.toThrow(/Google .* não configurada/);
    expect(f).not.toHaveBeenCalled();
  });

  it('enviar teste: mensagem de voz pelo chip da Clínica (nunca o Financeiro), com a config da clínica', async () => {
    global.fetch = jest.fn(async () => resp(200, null, Buffer.from('MP3'))) as any;
    const { s, whatsapp } = svc();
    await s.enviarTeste('T1', { motor: 'openai' }, '(82) 98888-7777'); // leitor de texto (mp3 cru)
    const c = (whatsapp.sendMedia as jest.Mock).mock.calls[0];
    expect(c[0]).toBe('82988887777');
    expect(c[1]).toBe('audio');
    expect(c[2]).toBe(Buffer.from('MP3').toString('base64'));
    expect(c[4]).toBe('clin');
    expect(c[6]).toBe('audio/mpeg');
    expect(c[8]).toBe('T1');
  });

  it('enviar teste: número sem WhatsApp / sem chip da clínica / telefone inválido', async () => {
    global.fetch = jest.fn(async () => resp(200, { choices: [{ message: { audio: { data: 'QQ==' } } }] })) as any;
    await expect(svc({ envio: { statusCode: 400, error: '{"exists":false}' } }).s.enviarTeste('T1', {}, '82988887777')).rejects.toThrow(/não tem WhatsApp/);
    await expect(svc({ chips: [{ name: 'fin', purpose: 'FINANCEIRO' }] }).s.enviarTeste('T1', {}, '82988887777')).rejects.toThrow(/chip da Clínica/);
    await expect(svc().s.enviarTeste('T1', {}, '123')).rejects.toThrow(/Telefone inválido/);
  });
});
