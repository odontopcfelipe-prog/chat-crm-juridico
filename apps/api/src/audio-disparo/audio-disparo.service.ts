import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  chipPacienteOuLegado,
  escolherChipPaciente,
  instrucaoVoz,
  isLabTenant,
  normalizarAudioConfig,
  textoParaFala,
  type AudioTesteConfig,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { negarLaboratorio } from '../common/lab-gate.util';
import { SettingsService } from '../settings/settings.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { numeroSemWhatsapp, wasSent } from '../whatsapp/envio-resultado';

const CONFIG_KEY = 'AUDIO_TESTE_CONFIG';
const OPENAI_MODEL = 'gpt-4o-mini-tts';
/** Voz do ChatGPT (Chat Completions com saída em áudio). Se a conta não tiver o 1º, tenta os próximos. */
export const CHATGPT_MODELOS = ['gpt-audio-1.5', 'gpt-audio', 'gpt-4o-audio-preview'];
/** O mesmo modelo que a IA já usa pra responder em áudio (ai.processor do worker). */
const GEMINI_MODEL = 'gemini-2.5-flash-preview-tts';

export type AudioGerado = { buffer: Buffer; mime: string };

/** Cabeçalho WAV pro PCM 16-bit do Gemini (24 kHz mono) — igual ao do ai.processor. */
export function wavDePcm(pcm: Buffer, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bits / 8);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(channels * (bits / 8), 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Lembrete em ÁUDIO (teste) — Central › Agendamento. Gera a mensagem de voz a partir do
 * texto (OpenAI ou Gemini, com a chave global da IA), toca a prévia na tela e manda o
 * teste pro número informado pelo chip da Clínica. NÃO envia sozinho pra paciente.
 */
@Injectable()
export class AudioDisparoService {
  private readonly logger = new Logger(AudioDisparoService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private whatsapp: WhatsappService,
  ) {}

  /** F2 parte 3b — a conta é laboratório? Sem conta: não. Clínica: só a leitura cacheada (60 s). */
  private ehLaboratorio(tenantId: string | null | undefined): Promise<boolean> {
    return isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
  }

  async getConfig(tenantId: string) {
    const row = await this.prisma.tenantSetting
      .findUnique({ where: { tenant_id_key: { tenant_id: tenantId, key: CONFIG_KEY } } })
      .catch(() => null);
    let salvo: any = null;
    try { salvo = row?.value ? JSON.parse(row.value) : null; } catch { salvo = null; }
    // F2 parte 3b — a chave do Google (voz Gemini) é das clínicas; o laboratório só
    // compartilha os créditos da OpenAI: para ele o motor Gemini fica desligado.
    const laboratorio = await this.ehLaboratorio(tenantId);
    const [ai, googleKey] = await Promise.all([this.settings.getAiConfig().catch(() => null), laboratorio ? null : this.settings.get('GOOGLE_TTS_API_KEY').catch(() => null)]);
    return {
      config: normalizarAudioConfig(salvo || {}),
      motores: { chatgpt: !!ai?.apiKey, openai: !!ai?.apiKey, gemini: !!googleKey },
    };
  }

  async setConfig(tenantId: string, body: any) {
    const cfg = normalizarAudioConfig(body || {});
    const value = JSON.stringify(cfg);
    await this.prisma.tenantSetting.upsert({
      where: { tenant_id_key: { tenant_id: tenantId, key: CONFIG_KEY } },
      create: { tenant_id: tenantId, key: CONFIG_KEY, value },
      update: { value },
    });
    return { config: cfg };
  }

  /** Valores de exemplo, com o nome REAL da clínica e de um dentista dela. */
  private async varsExemplo(tenantId: string): Promise<Record<string, string>> {
    const [tenant, dentista] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null),
      this.prisma.user.findFirst({
        where: { tenant_id: tenantId, OR: [{ roles: { has: 'DENTIST' } }, { roles: { has: 'ADMIN' }, specialties: { isEmpty: false } }] },
        select: { name: true },
        orderBy: { name: 'asc' },
      }).catch(() => null),
    ]);
    return { nome: 'Felipe', clinica: tenant?.name || 'nossa clínica', data: '22/06', hora: '15:00', dentista: dentista?.name || 'a doutora' };
  }

  /**
   * `tenantId` = conta de quem pede (ouvir / enviar teste). F2 parte 3b — a voz do
   * Google (Gemini) usa a chave GOOGLE_TTS_API_KEY das clínicas: LABORATÓRIO recebe
   * 403 VERTICAL_DENIED (OpenAI/ChatGPT seguem: créditos da plataforma).
   */
  async sintetizar(cfg: AudioTesteConfig, texto: string, tenantId?: string | null): Promise<AudioGerado> {
    if (!texto.trim()) throw new BadRequestException('A mensagem está vazia');
    if (cfg.motor === 'chatgpt') return this.vozDoChatgpt(cfg, texto);
    if (cfg.motor === 'openai') {
      const key = (await this.settings.getAiConfig())?.apiKey;
      if (!key) throw new BadRequestException('Chave da OpenAI não configurada (Configurações › Inteligência Artificial)');
      const pedir = (comVelocidade: boolean) =>
        fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            voice: cfg.voz,
            input: texto,
            instructions: instrucaoVoz(cfg),
            response_format: 'mp3',
            ...(comVelocidade ? { speed: cfg.velocidade } : {}),
          }),
          signal: AbortSignal.timeout(45000),
        });
      let res = await pedir(true);
      if (res.status === 400) {
        const corpo = await res.text().catch(() => '');
        // Se o modelo não aceitar o número de velocidade, fica só a instrução de ritmo.
        if (/speed/i.test(corpo)) res = await pedir(false);
        else throw new BadRequestException(`A OpenAI recusou (400): ${corpo.slice(0, 200)}`);
      }
      if (!res.ok) {
        const corpo = await res.text().catch(() => '');
        throw new BadRequestException(`A OpenAI recusou (${res.status}): ${corpo.slice(0, 200)}`);
      }
      return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
    }

    if (await this.ehLaboratorio(tenantId)) throw negarLaboratorio('Voz do Google (Gemini)');
    const key = await this.settings.get('GOOGLE_TTS_API_KEY');
    if (!key) throw new BadRequestException('Chave do Google (Text-to-Speech) não configurada (Configurações › Inteligência Artificial)');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${instrucaoVoz(cfg)} Agora diga: ${texto}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voz } } },
        },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      throw new BadRequestException(`O Google recusou (${res.status}): ${corpo.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) throw new BadRequestException('O Google não devolveu áudio — tente de novo');
    return { buffer: wavDePcm(Buffer.from(b64, 'base64')), mime: 'audio/wav' };
  }

  /**
   * Voz do ChatGPT: o modelo de áudio "fala interpretando" (bem mais natural que o leitor).
   * Como é um modelo de conversa, a instrução prende ele a falar SÓ o texto, palavra por
   * palavra. Ritmo e sotaque vão por instrução (não há número de velocidade).
   */
  private async vozDoChatgpt(cfg: AudioTesteConfig, texto: string): Promise<AudioGerado> {
    const key = (await this.settings.getAiConfig())?.apiKey;
    if (!key) throw new BadRequestException('Chave da OpenAI não configurada (Configurações › Inteligência Artificial)');
    const sistema =
      'Você é a voz de uma atendente de clínica odontológica gravando um áudio de WhatsApp. ' +
      `${instrucaoVoz(cfg)} ` +
      'Sua única tarefa é falar em voz alta, EXATAMENTE, o texto que está entre as aspas triplas — palavra por palavra, ' +
      'sem acrescentar, tirar, responder, comentar ou cumprimentar além do que está escrito, e sem dizer "claro" ou "aqui está".';
    let ultimoErro = '';
    for (const model of CHATGPT_MODELOS) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          modalities: ['text', 'audio'],
          audio: { voice: cfg.voz, format: 'mp3' },
          messages: [
            { role: 'system', content: sistema },
            { role: 'user', content: `"""${texto}"""` },
          ],
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) {
        const data: any = await res.json();
        const b64 = data?.choices?.[0]?.message?.audio?.data;
        if (!b64) throw new BadRequestException('A OpenAI não devolveu áudio — tente de novo');
        return { buffer: Buffer.from(b64, 'base64'), mime: 'audio/mpeg' };
      }
      const corpo = await res.text().catch(() => '');
      ultimoErro = `(${res.status}): ${corpo.slice(0, 200)}`;
      // Modelo indisponível pra esta conta → tenta o próximo; qualquer outro erro → para.
      const semModelo = res.status === 404 || (/model/i.test(corpo) && /not found|does not exist|do not have access|not supported/i.test(corpo));
      if (!semModelo) break;
      this.logger.warn(`[AUDIO-TESTE] modelo ${model} indisponível — tentando o próximo`);
    }
    throw new BadRequestException(`A OpenAI recusou ${ultimoErro}`);
  }

  /** Prévia pra tocar na tela (com os valores de exemplo). */
  async ouvir(tenantId: string, body: any): Promise<AudioGerado> {
    const cfg = normalizarAudioConfig(body || {});
    return this.sintetizar(cfg, textoParaFala(cfg.texto, await this.varsExemplo(tenantId)), tenantId);
  }

  /** Manda a mensagem de voz de teste pro número, pelo chip da Clínica (nunca o Financeiro). */
  async enviarTeste(tenantId: string, body: any, telefone: string) {
    const num = (telefone || '').replace(/\D/g, '');
    if (num.length < 10) throw new BadRequestException('Telefone inválido — use DDD + número');
    const chips = await this.prisma.instance.findMany({
      where: { type: 'whatsapp', tenant_id: tenantId },
      orderBy: { created_at: 'asc' },
      select: { name: true, purpose: true },
    });
    const chip = chipPacienteOuLegado(escolherChipPaciente(chips, 'CLINICA'));
    if (!chip) throw new BadRequestException('Nenhum chip da Clínica conectado nesta clínica');
    const cfg = normalizarAudioConfig(body || {});
    const audio = await this.sintetizar(cfg, textoParaFala(cfg.texto, await this.varsExemplo(tenantId)), tenantId);
    const res = await this.whatsapp.sendMedia(num, 'audio', audio.buffer.toString('base64'), undefined, chip, undefined, audio.mime, 90000, tenantId);
    if (!wasSent(res)) {
      throw new BadRequestException(numeroSemWhatsapp(res) ? 'Esse número não tem WhatsApp — confira' : `Não saiu: ${String((res as any)?.error || 'erro').slice(0, 160)}`);
    }
    this.logger.log(`[AUDIO-TESTE] ${cfg.motor}/${cfg.voz}/${cfg.sotaque}/${cfg.velocidade}x → ${num} (chip ${chip})`);
    return { ok: true };
  }
}
