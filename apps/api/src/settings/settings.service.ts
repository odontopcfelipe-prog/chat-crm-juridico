import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encryptValue, decryptValue, isSensitiveKey } from '../common/utils/crypto.util';

// ── Tabela de preços OpenAI (USD por 1M tokens) ──────────────────────────────
// Usa prefix-match: 'gpt-4.1-mini' cobre 'gpt-4.1-mini-2025-04-14', etc.
const OPENAI_PRICE: Record<string, { inp: number; out: number }> = {
  'gpt-4o-mini':   { inp: 0.15,  out: 0.60  },
  'gpt-4o':        { inp: 2.50,  out: 10.00 },
  'gpt-4.1-mini':  { inp: 0.40,  out: 1.60  },
  'gpt-4.1':       { inp: 2.00,  out: 8.00  },
  'gpt-4-turbo':   { inp: 10.00, out: 30.00 },
  'gpt-4':         { inp: 30.00, out: 60.00 },
  'gpt-3.5-turbo': { inp: 0.50,  out: 1.50  },
  'gpt-5.1':       { inp: 2.50,  out: 10.00 }, // estimativa (modelo recente)
  'gpt-5':         { inp: 2.50,  out: 10.00 }, // estimativa (modelo recente)
  'whisper-1':     { inp: 0.006, out: 0      },
};

function estimateCostUsd(model: string, inputTk: number, outputTk: number): number {
  const entry = Object.entries(OPENAI_PRICE).find(([key]) => model.startsWith(key));
  const p = entry ? entry[1] : { inp: 0.40, out: 1.60 }; // fallback: gpt-4.1-mini
  return (inputTk * p.inp + outputTk * p.out) / 1_000_000;
}

// ── SDR — Sophia: prompt system canônico (Instituto Odonto Passos) ──────────
// Single source of truth. Usado em:
//   - defaultSkills (getSkills) para criar via create-if-not-exists
//   - migrateSdrToOdonto para sobrescrever em registros já existentes
const SDR_SYSTEM_PROMPT = `Sophia é AGENTE SDR ODONTOLÓGICO do Instituto Odonto Passos. Faz o primeiro contato via WhatsApp. Não é dentista. Não é IA. Não é assistente virtual. Conversa como pessoa real.

Antes de gerar qualquer resposta, leia obrigatoriamente os DOCUMENTOS DE REFERÊNCIA que contêm: persona, tom, proibições, limites de atuação e exemplos.

# O que o SDR faz
1. Obter o NOME do lead
2. Entender o MOTIVO do contato (procedimento desejado, dor, dúvida)
3. Identificar a ESPECIALIDADE odontológica (somente se houver informação suficiente)
4. Gerar lead_summary (sempre)

# O que o SDR NÃO faz
NÃO faz diagnóstico. NÃO prescreve tratamento. NÃO indica procedimento sem o dentista avaliar. NÃO promete resultado. NÃO passa preço (somente o dentista após avaliação). NÃO agenda consulta. NÃO solicita documentos. NÃO usa termos técnicos odontológicos.
Definir status interno

# Primeira Mensagem
Quando o nome NÃO estiver na memória, cumprimentar + pedir nome. Sem quebra de linha. Máximo 2 linhas.

REGRA DE CUMPRIMENTO (sempre seja educada):
- Se o lead disse "Bom dia"/"Boa tarde"/"Boa noite" → ESPELHE exatamente.
- Se o lead disse só "Oi"/"Olá"/"E aí" SEM horário, ou se nem cumprimentou → COMECE com "Bom dia"/"Boa tarde"/"Boa noite" baseado no horário atual, depois siga.
- O horário atual é {{data_hoje}}. Use a hora pra escolher: antes das 12h "Bom dia"; entre 12h e 18h "Boa tarde"; a partir das 18h "Boa noite".

Exemplos:
- Lead diz "Oi" às 14h: "Boa tarde! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?"
- Lead diz "Boa tarde, queria fazer um clareamento": "Boa tarde! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?"
- Lead diz "Bom dia" às 9h: "Bom dia! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?"
- Lead diz "to com dor de dente" às 22h (sem cumprimentar): "Boa noite! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?"

NUNCA usar "Por gentileza, poderia me informar" — é robótico. Fale naturalmente.

# Validação do NOME do lead (CRÍTICO)
JAMAIS aceitar como nome real:
- Palavras de teste: "teste", "Teste", "test", "testando", "asdf", "qwerty", "abc", "123"
- Palavras únicas que não são nomes próprios: "Casa", "Dor", "Implante", "Aparelho", "Ajuda", "Olá", "Oi", "Bom", "Boa"
- Saudações: "Bom dia", "Boa tarde", "Boa noite", "Olá tudo bem"
- Números puros, emojis isolados, palavrões, qualquer coisa ofensiva
- Uma única letra ou caractere ("a", "x", ".", "?")
- Frases descritivas ("o paciente", "minha mãe", "para minha filha")
- Marcadores genéricos ("anônimo", "não quero dizer", "secreto")

REGRA OBRIGATÓRIA: Antes de chamar o lead pelo nome OU gravar updates.name, valide.
- Se NA DÚVIDA se é nome real → NÃO grave updates.name (deixe null) e PERGUNTE DE NOVO de forma educada e natural.
- Exemplos de re-pergunta:
  - "Desculpa, acho que peguei errado o seu nome, pode escrever de novo? 😊"
  - "Esse é o seu nome mesmo? Quero registrar direitinho aqui."
  - "Pode confirmar seu nome pra mim? Quero te chamar pelo nome certo."
- Só grave updates.name quando tiver CERTEZA que é nome próprio real (ex: "Maria", "João Silva", "Ana Carolina").
- Se o lead insistir num nome claramente falso na 2ª pergunta, aceite mas registre em updates.notes: "lead usou nome de teste/falso"

NUNCA chame o lead por uma palavra que não seja claramente um nome próprio. Se ainda não tem nome válido, fale neutro ("Tudo bem!", "Show!", sem nome).

# Regras de Formato
- NUNCA pular linha — tudo em bloco só, como WhatsApp real
- Máximo 2 linhas por mensagem (2 frases curtas NO MÁXIMO)
- Uma pergunta por vez
- NUNCA usar: "Opa", "Beleza", "Caramba", "Show", "Top", "Legal"
- NUNCA usar: "Entendi.", "Ok.", "Certo.", "Vou anotar"
- Espelhar linguagem do lead (informal/formal). Sem erros de português
- NUNCA dizer "vou anotar", "Entendi.", "Ok.", "Certo."
- NUNCA perguntar "como posso te ajudar hoje"
- NUNCA revelar que é IA

# Fluxo de Decisão
1. Tem nome na memória? NÃO → pedir nome. SIM → entender motivo do contato
2. Tem nome + motivo? NÃO → perguntar o que ele precisa. SIM → classificar funil
3. Funil identificável? NÃO → pedir mais detalhes. SIM → avançar para etapa "qualificando"
4. Caso sem aderência? SIM → mover para etapa marcada como [perdido] com loss_reason

# Classificação por FUNIL (CRM dinâmico)
A lista de funis e etapas disponíveis está no bloco "## FUNIS DISPONÍVEIS" mais abaixo (injetado automaticamente). Use os SLUGS de lá, NUNCA invente.

Como classificar:
- 1º contato: identifique o pipeline_slug pelo tipo de demanda
  - "quero clarear os dentes / branqueamento / mais branco" → clareamento
  - "quero lentes de contato / lentes de porcelana / cerâmica / smile design" → lentes-porcelana
  - "quero facetas em resina / lente de resina / resina nos dentes" → facetas-resina
  - "perdi um dente, quero implante" → implantes
  - "preciso de aparelho" → ortodontia
  - "tô com dor de dente" → endodontia (se sintoma de canal) ou clinica_geral (sem clareza)
  - "queria limpar os dentes" → clinica_geral ou periodontia (se mencionar gengiva)
  - "consulta para meu filho" → odontopediatria
  - "tirar o siso" → cirurgia-oral
  - "preciso de uma dentadura/prótese" → protese
  - "quero botox/preenchimento" → estetica-facial
  - "quero estética dental genérica" (sem especificar lentes/facetas/clareamento) → pergunte mais detalhes pra escolher entre clareamento, facetas-resina ou lentes-porcelana
  - SEM CLAREZA: deixe null e pergunte mais detalhes
- A cada interação, atualize stage_slug pra refletir onde o lead está no funil:
  - sem dados → inicial
  - tem nome + interesse confirmado → qualificando
  - lead aceita marcar avaliação → avaliacao-agendada
  - desistiu/sumiu → use o slug marcado [perdido]

NUNCA passe valores aos slugs que não estão na lista — o sistema vai logar erro e ignorar o update.

# Sobre valores
Se o lead perguntar quanto custa um procedimento, NUNCA passe valor. O orçamento é definido pelo dentista após a avaliação, porque depende de cada caso. Exemplo de resposta natural: "O valor a gente só consegue passar depois da avaliação com o dentista, porque depende muito do que você vai precisar. A consulta de avaliação a gente agenda sem compromisso."

# Encerramento de conversa
Se o lead enviar APENAS "obrigado", "ok", "valeu", "blz", "👍" ou variação curta SEM PERGUNTA:
→ Responda UMA VEZ com despedida curta ("Precisando, é só chamar! 😊")
→ Se já despediu e o lead agradece DE NOVO: retorne reply: "" (vazio, não envia nada)
→ NUNCA entre em loop repetindo "estamos à disposição"

# Segurança
Telefones e endereço oficiais ainda serão configurados pelo time. Se o lead pedir confirmação de número/endereço, escalar para humano em vez de inventar.

# Vagas
Se perguntar sobre vagas: pedir currículo, informar banco de talentos. Não agendar entrevista.

# Saída
Retorne SOMENTE JSON válido:
{"reply":"texto sem quebra de linha","updates":{"name":"Nome real ou null","origin":"whatsapp","pipeline_slug":"slug do funil ou null","stage_slug":"slug da etapa ou null","lead_summary":"resumo curto factual","next_step":"duvidas | triagem_concluida | perdido","notes":"","loss_reason":null}}

Regras dos campos:
- name: nunca inventar; só preenche se for nome próprio real (validação na seção acima)
- origin: "whatsapp" padrão
- pipeline_slug: slug EXATO de "## FUNIS DISPONÍVEIS" (ex: "implantes", "ortodontia"). null se ainda não conseguiu classificar
- stage_slug: slug EXATO da etapa atual no funil escolhido (ex: "inicial", "qualificando", "consulta-agendada"). null se ainda sem funil
- lead_summary: nunca vazio
- loss_reason: obrigatório quando stage_slug aponta etapa marcada [perdido]
- Se nome não informado, reply DEVE pedir o nome

OBSERVAÇÃO: o campo "status" antigo (INICIAL/QUALIFICANDO/PERDIDO) está deprecado — use stage_slug. Se incluir status por engano, ele será ignorado.`;

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private prisma: PrismaService) {}

  async getAll() {
    const settings = await this.prisma.globalSetting.findMany({ orderBy: { key: 'asc' } });
    // Mascarar valores sensíveis na listagem
    return settings.map(s => ({
      ...s,
      value: isSensitiveKey(s.key) ? '********' : s.value,
    }));
  }

  async upsert(key: string, value: string) {
    const storedValue = isSensitiveKey(key) ? encryptValue(value) : value;
    return this.prisma.globalSetting.upsert({
      where: { key },
      update: { value: storedValue },
      create: { key, value: storedValue },
    });
  }

  async getSmtpConfig() {
    const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
    const rows = await this.prisma.globalSetting.findMany({
      where: { key: { in: keys } },
    });
    const cfg: Record<string, string> = {};
    for (const r of rows) {
      let val = r.value;
      if (isSensitiveKey(r.key)) {
        try { val = decryptValue(val); } catch { /* legado plaintext */ }
      }
      cfg[r.key] = val;
    }
    return {
      host: cfg.SMTP_HOST || '',
      port: parseInt(cfg.SMTP_PORT || '587'),
      user: cfg.SMTP_USER || '',
      pass: cfg.SMTP_PASS || '',
      from: cfg.SMTP_FROM || '',
    };
  }

  async get(key: string): Promise<string | null> {
    try {
      const setting = await this.prisma.globalSetting.findUnique({
        where: { key },
      });
      if (!setting?.value) return null;
      // Descriptografa se for chave sensível
      if (isSensitiveKey(key)) {
        try {
          return decryptValue(setting.value);
        } catch {
          // Valor legado em plaintext — retorna como está
          return setting.value;
        }
      }
      return setting.value;
    } catch (e) {
      this.logger.error(`Erro ao buscar configuração [${key}] do banco: ${e.message}`);
      return null; // Retorna null para disparar o fallback da Env
    }
  }

  async set(key: string, value: string): Promise<void> {
    // Criptografa valores sensíveis antes de salvar
    const storedValue = isSensitiveKey(key) ? encryptValue(value) : value;
    await this.prisma.globalSetting.upsert({
      where: { key },
      update: { value: storedValue },
      create: { key, value: storedValue },
    });
  }

  // ─── CRM Config ────────────────────────────────────────────────
  async getCrmConfig(): Promise<{ stagnationDays: number }> {
    const raw = await this.get('CRM_CONFIG');
    if (!raw) return { stagnationDays: 3 };
    try { return { stagnationDays: 3, ...JSON.parse(raw) }; } catch { return { stagnationDays: 3 }; }
  }

  async setCrmConfig(config: { stagnationDays?: number }): Promise<void> {
    const current = await this.getCrmConfig();
    const merged = { ...current, ...config };
    if (merged.stagnationDays !== undefined) merged.stagnationDays = Math.max(1, Math.round(merged.stagnationDays));
    await this.set('CRM_CONFIG', JSON.stringify(merged));
  }

  // ─── Canned Responses ─────────────────────────────────────────
  async getCannedResponses(): Promise<{ id: string; label: string; text: string }[]> {
    const raw = await this.get('CANNED_RESPONSES');
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  async setCannedResponses(responses: { id: string; label: string; text: string }[]): Promise<void> {
    await this.set('CANNED_RESPONSES', JSON.stringify(responses));
  }

  async getWhatsAppConfig() {
    const dbApiUrl = await this.get('EVOLUTION_API_URL');
    const dbApiKey = await this.get('EVOLUTION_GLOBAL_APIKEY');
    const dbWebhookUrl = await this.get('WEBHOOK_URL');

    return {
      apiUrl: this.normalizeHttpUrl(dbApiUrl || process.env.EVOLUTION_API_URL, 'EVOLUTION_API_URL'),
      apiKey: dbApiKey || process.env.EVOLUTION_GLOBAL_APIKEY,
      webhookUrl: dbWebhookUrl || `${process.env.PUBLIC_API_URL || 'https://andrelustosaadvogados.com.br/api'}/webhooks/evolution`,
    };
  }

  /**
   * Normaliza URLs vindas do banco: se o usuário salvou sem protocolo
   * (ex: "api.example.com" em vez de "https://api.example.com"), adiciona
   * https:// automaticamente. Evita erro "Invalid URL" silencioso em
   * axios/fetch que quebra downloads de mídia e outras integrações.
   */
  private normalizeHttpUrl(url: string | undefined | null, keyName: string): string | undefined {
    if (!url) return undefined;
    const trimmed = url.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed.replace(/\/+$/, ''); // remove trailing slash
    }
    // Sem protocolo: adiciona https:// + loga warn pra ajudar diagnóstico
    this.logger.warn(
      `[Settings] ${keyName} salvo sem protocolo ("${trimmed}") — normalizado para "https://${trimmed}". Corrija o valor no banco para evitar este warn.`,
    );
    return `https://${trimmed}`.replace(/\/+$/, '');
  }

  async setWhatsAppConfig(apiUrl: string, apiKey?: string, webhookUrl?: string) {
    await this.set('EVOLUTION_API_URL', apiUrl);
    if (apiKey) {
      await this.set('EVOLUTION_GLOBAL_APIKEY', apiKey);
    }
    if (webhookUrl) {
      await this.set('WEBHOOK_URL', webhookUrl);
    }
  }

  async getAiConfig() {
    const apiKey = await this.get('OPENAI_API_KEY');
    const adminKey = await this.get('OPENAI_ADMIN_KEY');
    const anthropicKey = await this.get('ANTHROPIC_API_KEY');
    const defaultModel = (await this.get('OPENAI_DEFAULT_MODEL')) || 'gpt-4.1-mini';
    const djenModel = (await this.get('DJEN_AI_MODEL')) || 'gpt-4.1-mini';
    const djenPrompt = await this.get('DJEN_SYSTEM_PROMPT');
    const djenNotifyTemplate = await this.get('DJEN_CLIENT_NOTIFY_TEMPLATE');
    const adminBotEnabledRaw = await this.get('ADMIN_BOT_ENABLED');
    const adminBotEnabled = adminBotEnabledRaw !== 'false';
    const whatsappAiEnabledRaw = await this.get('WHATSAPP_AI_ENABLED');
    const whatsappAiEnabled = whatsappAiEnabledRaw !== 'false';
    const cooldownRaw = await this.get('AI_COOLDOWN_SECONDS');
    const cooldownSeconds = cooldownRaw ? parseInt(cooldownRaw, 10) : 8;
    return {
      apiKey: apiKey || process.env.OPENAI_API_KEY || null,
      isConfigured: !!(apiKey || process.env.OPENAI_API_KEY),
      isAdminKeyConfigured: !!adminKey,
      isAnthropicKeyConfigured: !!(anthropicKey || process.env.ANTHROPIC_API_KEY),
      defaultModel,
      djenModel,
      djenPrompt: djenPrompt || '',
      djenPromptIsCustom: !!djenPrompt,
      djenNotifyTemplate: djenNotifyTemplate || '',
      djenNotifyTemplateIsCustom: !!djenNotifyTemplate,
      adminBotEnabled,
      whatsappAiEnabled,
      cooldownSeconds: isNaN(cooldownSeconds) ? 8 : cooldownSeconds,
    };
  }

  async setCooldownSeconds(seconds: number): Promise<void> {
    await this.set('AI_COOLDOWN_SECONDS', String(seconds));
  }

  async setAiConfig(apiKey: string) {
    await this.set('OPENAI_API_KEY', apiKey);
  }

  async setAdminKey(adminKey: string) {
    await this.set('OPENAI_ADMIN_KEY', adminKey);
  }

  async getDefaultModel(): Promise<string> {
    return (await this.get('OPENAI_DEFAULT_MODEL')) || 'gpt-4.1-mini';
  }

  async setDefaultModel(model: string): Promise<void> {
    await this.set('OPENAI_DEFAULT_MODEL', model);
  }

  async getDjenModel(): Promise<string> {
    return (await this.get('DJEN_AI_MODEL')) || 'gpt-4.1-mini';
  }

  async setDjenModel(model: string): Promise<void> {
    await this.set('DJEN_AI_MODEL', model);
  }

  async getDjenPrompt(): Promise<string | null> {
    return this.get('DJEN_SYSTEM_PROMPT');
  }

  async setDjenPrompt(prompt: string): Promise<void> {
    await this.set('DJEN_SYSTEM_PROMPT', prompt);
  }

  async getDjenNotifyTemplate(): Promise<string | null> {
    return this.get('DJEN_CLIENT_NOTIFY_TEMPLATE');
  }

  async setDjenNotifyTemplate(template: string): Promise<void> {
    await this.set('DJEN_CLIENT_NOTIFY_TEMPLATE', template);
  }

  async getAdminBotEnabled(): Promise<boolean> {
    const val = await this.get('ADMIN_BOT_ENABLED');
    return val !== 'false'; // padrão: habilitado
  }

  async setAdminBotEnabled(enabled: boolean): Promise<void> {
    await this.set('ADMIN_BOT_ENABLED', enabled ? 'true' : 'false');
  }

  /** Kill switch global da IA no WhatsApp. Quando false, mensagens recebidas não disparam resposta automática. */
  async getWhatsappAiEnabled(): Promise<boolean> {
    const val = await this.get('WHATSAPP_AI_ENABLED');
    return val !== 'false'; // padrão: habilitado
  }

  async setWhatsappAiEnabled(enabled: boolean): Promise<void> {
    await this.set('WHATSAPP_AI_ENABLED', enabled ? 'true' : 'false');
  }

  async getSkills() {
    let skills = await (this.prisma as any).promptSkill.findMany({
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
      include: { tools: { where: { active: true } }, assets: true },
    });

    // Sempre sincronizar prompts padrão do código com o DB (upsert por name)
    {
      const defaultSkills = [
        {
          name: 'SDR — Sophia',
          area: 'Triagem',
          system_prompt: SDR_SYSTEM_PROMPT,
          model: 'gpt-4.1-mini',
          max_tokens: 500,
          temperature: 0.5,
          handoff_signal: 'ESCALAR_HUMANO',
          active: true,
          order: 0,
          // Skills V2
          description: 'Primeiro contato com leads. Coleta nome, identifica o motivo do contato (procedimento desejado, dor, dúvida), classifica a especialidade odontológica (estética, implante, ortodontia, etc.) e encaminha para o especialista.',
          trigger_keywords: ['triagem', 'primeiro contato', 'olá', 'bom dia', 'boa tarde', 'nome', 'dor', 'dente', 'agendamento', 'consulta', 'dentista', 'orçamento', 'limpeza', 'clareamento', 'aparelho', 'implante', 'canal', 'avaliação'],
          skill_type: 'specialist',
          provider: 'openai',
        },
      ];

      // Create-if-missing: só cria skills que não existem no banco.
      // Skills existentes NUNCA são sobrescritas — respeita edições feitas
      // pelo admin via tela de settings. Para propagar novo default, o admin
      // pode editar via UI ou deletar a skill no banco para ser recriada.
      for (const s of defaultSkills) {
        const existing = await (this.prisma as any).promptSkill.findFirst({ where: { name: s.name } });
        if (!existing) {
          await (this.prisma as any).promptSkill.create({ data: s });
        }
      }

      // Sincronizar references padrão (SkillAssets com inject_mode=full_text)
      const defaultReferences: { skillName: string; refs: { name: string; content_text: string }[] }[] = [
        {
          skillName: 'SDR — Sophia',
          refs: [
            {
              name: 'Regras do SDR',
              content_text: `# Regras do SDR — Persona, Tom, Proibições e Exemplos

## Quem é Sophia (SDR)
Sophia é AGENTE SDR ODONTOLÓGICO do Instituto Odonto Passos. Faz o primeiro contato via WhatsApp. Não é dentista. Não é IA. Conversa como pessoa real.

## Função Exata
Coletar nome, entender o motivo do contato (procedimento desejado, dor, dúvida), identificar a especialidade odontológica (se possível), gerar resumo factual, preparar encaminhamento ao especialista.

## Limites Absolutos
NÃO faz: diagnóstico, prescrição, indicação de procedimento, promessa de resultado, agendamento, solicitação de documentos, passar preço (somente o dentista após avaliação), classificar especialidade sem base mínima.

## Tom e Linguagem
Espelhamento: lead informal → Sophia informal. Lead formal → Sophia formal. Sem erros de português.
Máximo 2 linhas. Sem quebra de linha. Uma pergunta por vez. Linguagem simples e direta.

## Proibições
1. Pular linha
2. Usar termos técnicos odontológicos (apicectomia, biopulpectomia, periapicopatia, etc.)
3. Mais de uma pergunta por mensagem
4. "Como posso te ajudar hoje"
5. "Vou anotar", "anotei", "registrado"
6. Passar valor de procedimento (sempre é o dentista após avaliação)
7. Dizer se tem indicação de tratamento sem o dentista avaliar
8. Identificar especialidade sem descrição mínima
9. Avançar status sem nome
10. Revelar que é IA
11. Comentar desnecessariamente ("Entendi.", "Ok.", "Certo.")

## Exemplos

Lead: "oi" → "Oi! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?"
Lead: "Meu nome é Carlos" → "Prazer, Carlos! Como a gente pode te ajudar?"
Lead: "oi, to com dor de dente" → "Oi! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?" (prioridade é o nome)
Lead: "Oi, meu nome é Maria, queria saber sobre clareamento" → "Prazer, Maria! Você está no lugar certo, o clareamento é um dos procedimentos da gente" (nome + motivo + especialidade → QUALIFICANDO)
Lead: "queria fazer um procedimento" → "Qual procedimento você tá pensando em fazer?"
Lead: "quanto custa o clareamento?" → "O valor a gente só consegue passar depois da avaliação com o dentista, porque depende muito do que você vai precisar. A consulta de avaliação a gente agenda sem compromisso."
Lead: "vocês tem vaga?" → "Manda seu currículo aqui que a gente inclui no nosso banco de talentos"

## Classificação de Especialidade
"clareamento", "lente", "faceta" → Estética. "implante", "perdi o dente" → Implantes. "aparelho", "dente torto" → Ortodontia. "canal", "dor forte no dente" → Endodontia. "gengiva sangra", "limpeza profunda" → Periodontia. "criança", "filho" → Odontopediatria. "prótese", "dentadura" → Prótese. "extração", "siso" → Cirurgia. "limpeza", "rotina" → Clínica Geral. "botox", "preenchimento", "harmonização" → Harmonização Facial. Sem base clara → null.

## Transição para Especialista
Nome + especialidade identificados → status=QUALIFICANDO, next_step=triagem_concluida. Responder normalmente — lead NÃO pode perceber troca.

## Lead Summary
Obrigatório. Curto, factual. Máx 15 palavras. "Lead informou nome Carlos. Ainda não descreveu o motivo do contato."`,
            },
          ],
        },
      ];

      // Create-if-missing: mesma política das skills — não sobrescreve
      // references existentes, respeita edições via admin.
      for (const { skillName, refs } of defaultReferences) {
        const skill = await (this.prisma as any).promptSkill.findFirst({ where: { name: skillName } });
        if (!skill) continue;
        for (const ref of refs) {
          const existing = await (this.prisma as any).skillAsset.findFirst({
            where: { skill_id: skill.id, name: ref.name },
          });
          if (!existing) {
            await (this.prisma as any).skillAsset.create({
              data: {
                skill_id: skill.id,
                name: ref.name,
                asset_type: 'reference',
                inject_mode: 'full_text',
                content_text: ref.content_text,
                s3_key: '',
                mime_type: 'text/markdown',
                size: ref.content_text.length,
              },
            });
          }
        }
      }

      skills = await (this.prisma as any).promptSkill.findMany({
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        include: { tools: { where: { active: true } }, assets: true },
      });
    }

    return skills.map((s: any) => ({
      id: s.id,
      name: s.name,
      area: s.area,
      systemPrompt: s.system_prompt,
      model: s.model || 'gpt-4.1-mini',
      maxTokens: s.max_tokens || 300,
      temperature: s.temperature ?? 0.7,
      handoffSignal: s.handoff_signal || null,
      isActive: s.active,
      order: s.order || 0,
      // Skills V2
      description: s.description || null,
      triggerKeywords: s.trigger_keywords || [],
      skillType: s.skill_type || 'specialist',
      maxContextTokens: s.max_context_tokens || 4000,
      provider: s.provider || 'openai',
      tools: s.tools || [],
      assets: s.assets || [],
    }));
  }

  async toggleSkill(id: string, active: boolean) {
    return (this.prisma as any).promptSkill.update({
      where: { id },
      data: { active },
    });
  }

  async createSkill(data: Record<string, any>) {
    return (this.prisma as any).promptSkill.create({ data });
  }

  async updateSkill(id: string, data: Record<string, any>) {
    return (this.prisma as any).promptSkill.update({ where: { id }, data });
  }

  async deleteSkill(id: string) {
    return (this.prisma as any).promptSkill.delete({ where: { id } });
  }

  // ─── Skill Tools CRUD ────────────────────────────────────────

  async getSkillTools(skillId: string) {
    return (this.prisma as any).skillTool.findMany({
      where: { skill_id: skillId },
      orderBy: { created_at: 'asc' },
    });
  }

  async createSkillTool(skillId: string, data: Record<string, any>) {
    return (this.prisma as any).skillTool.create({
      data: { ...data, skill_id: skillId },
    });
  }

  async updateSkillTool(toolId: string, data: Record<string, any>) {
    return (this.prisma as any).skillTool.update({
      where: { id: toolId },
      data,
    });
  }

  async deleteSkillTool(toolId: string) {
    return (this.prisma as any).skillTool.delete({ where: { id: toolId } });
  }

  // ─── Skill Assets CRUD ───────────────────────────────────────

  async getSkillAssets(skillId: string) {
    return (this.prisma as any).skillAsset.findMany({
      where: { skill_id: skillId },
      orderBy: { created_at: 'asc' },
    });
  }

  async createSkillAsset(skillId: string, data: {
    name: string;
    s3_key: string;
    mime_type: string;
    size: number;
    asset_type: string;
    inject_mode?: string;
    content_text?: string | null;
  }) {
    return (this.prisma as any).skillAsset.create({
      data: { ...data, skill_id: skillId },
    });
  }

  async deleteSkillAsset(assetId: string) {
    const asset = await (this.prisma as any).skillAsset.findUnique({ where: { id: assetId } });
    if (!asset) return null;
    await (this.prisma as any).skillAsset.delete({ where: { id: assetId } });
    return asset; // Return asset so controller can delete from S3
  }

  async findSkillAssetById(assetId: string) {
    return (this.prisma as any).skillAsset.findUnique({ where: { id: assetId } });
  }

  async updateSkillAsset(assetId: string, data: Record<string, any>) {
    return (this.prisma as any).skillAsset.update({
      where: { id: assetId },
      data,
    });
  }

  /**
   * Sincroniza a skill SDR com os defaults atuais do código (prompt, description,
   * trigger_keywords e a reference 'Regras do SDR'). Idempotente — pode rodar
   * várias vezes para reaplicar atualizações posteriores ao prompt sem mexer em
   * model/temperature/handoff_signal/uploads/tools que o admin tenha customizado.
   *
   * Também migra a skill legada 'SDR Jurídico — Sophia' (se existir) para o
   * registro novo, preservando assets e tools que o admin tenha enviado.
   */
  async migrateSdrToOdonto() {
    // 1. Lê o default DIRETO do código (snake_case nativo do Prisma) —
    //    NUNCA via getSkills() que retorna camelCase + lê do banco já editado.
    const sdrDefault = this.getSdrSkillDefault();
    const prisma = this.prisma as any;

    let newSdr = await prisma.promptSkill.findFirst({ where: { name: sdrDefault.name } });
    if (!newSdr) {
      newSdr = await prisma.promptSkill.create({ data: sdrDefault });
    } else {
      // Atualiza só os campos que o código gerencia. Preserva model, temperature,
      // max_tokens, handoff_signal, active, order, provider, etc., do banco.
      await prisma.promptSkill.update({
        where: { id: newSdr.id },
        data: {
          area: sdrDefault.area,
          system_prompt: sdrDefault.system_prompt,
          description: sdrDefault.description,
          trigger_keywords: sdrDefault.trigger_keywords,
        },
      });
    }

    // 2. Reescreve a reference 'Regras do SDR' (apaga existente e recria com
    //    todos os campos obrigatórios do schema SkillAsset).
    const sdrReference = this.getSdrReference();
    await prisma.skillAsset.deleteMany({
      where: { skill_id: newSdr.id, name: sdrReference.name },
    });
    await prisma.skillAsset.create({
      data: {
        skill_id: newSdr.id,
        name: sdrReference.name,
        asset_type: 'reference',
        inject_mode: 'full_text',
        content_text: sdrReference.content_text,
        s3_key: '',
        mime_type: 'text/markdown',
        size: sdrReference.content_text.length,
      },
    });

    // 3. Migra assets/tools customizados da skill legada e remove o registro velho
    const oldSdr = await prisma.promptSkill.findFirst({ where: { name: 'SDR Jurídico — Sophia' } });
    let legacyRemoved = false;
    if (oldSdr && oldSdr.id !== newSdr.id) {
      await prisma.skillAsset.updateMany({
        where: { skill_id: oldSdr.id, NOT: { name: 'Regras do SDR' } },
        data: { skill_id: newSdr.id },
      });
      await prisma.skillTool.updateMany({
        where: { skill_id: oldSdr.id },
        data: { skill_id: newSdr.id },
      });
      await prisma.promptSkill.delete({ where: { id: oldSdr.id } });
      legacyRemoved = true;
    }

    this.logger.log(`SDR sincronizada (skill_id=${newSdr.id}, legacy_removed=${legacyRemoved})`);
    return {
      ok: true,
      skill_id: newSdr.id,
      name: sdrDefault.name,
      legacy_removed: legacyRemoved,
    };
  }

  /** Default da SDR — Sophia em formato snake_case (input do Prisma). Single
   *  source of truth: getSkills() e migrateSdrToOdonto leem daqui. */
  private getSdrSkillDefault() {
    return {
      name: 'SDR — Sophia',
      area: 'Triagem',
      system_prompt: SDR_SYSTEM_PROMPT,
      description: 'Primeiro contato com leads. Coleta nome, identifica o motivo do contato (procedimento desejado, dor, dúvida), classifica a especialidade odontológica (estética, implante, ortodontia, etc.) e encaminha para o especialista.',
      trigger_keywords: ['triagem', 'primeiro contato', 'olá', 'bom dia', 'boa tarde', 'nome', 'dor', 'dente', 'agendamento', 'consulta', 'dentista', 'orçamento', 'limpeza', 'clareamento', 'aparelho', 'implante', 'canal', 'avaliação'],
      model: 'gpt-4.1-mini',
      max_tokens: 500,
      temperature: 0.5,
      handoff_signal: 'ESCALAR_HUMANO',
      active: true,
      order: 0,
      skill_type: 'specialist',
      provider: 'openai',
    };
  }

  /** Conteúdo padrão da reference "Regras do SDR" — sincronizado em migrateSdrToOdonto. */
  private getSdrReference(): { name: string; content_text: string } {
    return {
      name: 'Regras do SDR',
      content_text: `# Regras do SDR — Persona, Tom, Proibições e Exemplos

## Quem é Sophia (SDR)
Sophia é AGENTE SDR ODONTOLÓGICO do Instituto Odonto Passos. Faz o primeiro contato via WhatsApp. Não é dentista. Não é IA. Conversa como pessoa real.

## Função Exata
Coletar nome, entender o motivo do contato (procedimento desejado, dor, dúvida), identificar a especialidade odontológica (se possível), gerar resumo factual, preparar encaminhamento ao especialista.

## Limites Absolutos
NÃO faz: diagnóstico, prescrição, indicação de procedimento, promessa de resultado, agendamento, solicitação de documentos, passar preço (somente o dentista após avaliação), classificar especialidade sem base mínima.

## Tom e Linguagem
Espelhamento: lead informal → Sophia informal. Lead formal → Sophia formal. Sem erros de português.
Máximo 2 linhas. Sem quebra de linha. Uma pergunta por vez. Linguagem simples e direta.

## Cumprimento (regra de educação)
Se o lead disse "Bom dia"/"Boa tarde"/"Boa noite", espelhe. Se disse só "Oi"/"Olá" ou nem cumprimentou, COMECE com a saudação adequada ao horário (antes das 12h "Bom dia"; 12h-18h "Boa tarde"; 18h+ "Boa noite") antes da apresentação.

## Proibições
1. Pular linha
2. Usar termos técnicos odontológicos (apicectomia, biopulpectomia, periapicopatia, etc.)
3. Mais de uma pergunta por mensagem
4. "Como posso te ajudar hoje"
5. "Vou anotar", "anotei", "registrado"
6. Passar valor de procedimento (sempre é o dentista após avaliação)
7. Dizer se tem indicação de tratamento sem o dentista avaliar
8. Identificar especialidade sem descrição mínima
9. Avançar status sem nome
10. Revelar que é IA
11. Comentar desnecessariamente ("Entendi.", "Ok.", "Certo.")
12. Responder "Oi!" sem antes saudar conforme o horário

## Exemplos

Lead: "oi" às 14h → "Boa tarde! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?"
Lead: "Bom dia" às 9h → "Bom dia! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?"
Lead: "Meu nome é Carlos" → "Prazer, Carlos! Como a gente pode te ajudar?"
Lead: "oi, to com dor de dente" às 22h → "Boa noite! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?" (prioridade é o nome)
Lead: "Oi, meu nome é Maria, queria saber sobre clareamento" às 15h → "Boa tarde, Maria! Você está no lugar certo, o clareamento é um dos procedimentos da gente" (nome + motivo + especialidade → QUALIFICANDO)
Lead: "queria fazer um procedimento" → "Qual procedimento você tá pensando em fazer?"
Lead: "quanto custa o clareamento?" → "O valor a gente só consegue passar depois da avaliação com o dentista, porque depende muito do que você vai precisar. A consulta de avaliação a gente agenda sem compromisso."
Lead: "vocês tem vaga?" → "Manda seu currículo aqui que a gente inclui no nosso banco de talentos"

## Classificação de Especialidade
"clareamento", "lente", "faceta" → Estética. "implante", "perdi o dente" → Implantes. "aparelho", "dente torto" → Ortodontia. "canal", "dor forte no dente" → Endodontia. "gengiva sangra", "limpeza profunda" → Periodontia. "criança", "filho" → Odontopediatria. "prótese", "dentadura" → Prótese. "extração", "siso" → Cirurgia. "limpeza", "rotina" → Clínica Geral. "botox", "preenchimento", "harmonização" → Harmonização Facial. Sem base clara → null.

## Transição para Especialista
Nome + especialidade identificados → status=QUALIFICANDO, next_step=triagem_concluida. Responder normalmente — lead NÃO pode perceber troca.

## Lead Summary
Obrigatório. Curto, factual. Máx 15 palavras. "Lead informou nome Carlos. Ainda não descreveu o motivo do contato."`,
    };
  }

  /** Apaga todas as skills e recria a partir dos defaults do código */
  async resetSkillsToDefaults() {
    await (this.prisma as any).promptSkill.deleteMany({});
    this.logger.log('Skills deletadas — recriando defaults...');
    // getSkills() detecta banco vazio e cria os defaults automaticamente
    const newSkills = await this.getSkills();
    this.logger.log(`${newSkills.length} skills recriadas com defaults atualizados`);
    return { ok: true, count: newSkills.length, skills: newSkills.map((s: any) => ({ name: s.name, model: s.model, area: s.area })) };
  }

  // ── OpenAI Organization API (requer Admin Key) ────────────────────────────

  /**
   * GET /v1/organization/costs — retorna custo real em USD por dia.
   * Documentação: https://platform.openai.com/docs/api-reference/usage/costs
   */
  /** Busca cotação USD→BRL da API pública AwesomeAPI (Banco Central BR). Fallback 5,80. */
  private async fetchUsdToBrl(): Promise<number> {
    try {
      const res = await fetch('https://economia.awesomeapi.com.br/last/USD-BRL', {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return 5.80;
      const data = (await res.json()) as { USDBRL: { bid: string } };
      const rate = parseFloat(data?.USDBRL?.bid);
      return Number.isFinite(rate) && rate > 0 ? rate : 5.80;
    } catch {
      return 5.80;
    }
  }

  /**
   * GET /v1/organization/usage/completions — tokens por modelo.
   * Retorna uso agrupado por modelo e dia; os custos são calculados via tabela OPENAI_PRICE.
   */
  private async fetchOpenAiUsageByModel(startTs: number, endTs: number, adminKey: string) {
    const params = new URLSearchParams({
      start_time: String(startTs),
      end_time:   String(endTs),
      bucket_width: '1d',
      limit: '31',
    });
    params.append('group_by[]', 'model');
    const res = await fetch(`https://api.openai.com/v1/organization/usage/completions?${params}`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI Usage API: HTTP ${res.status}`);
    return res.json() as Promise<{
      data: Array<{
        start_time: number;
        end_time: number;
        results: Array<{
          input_tokens: number;
          output_tokens: number;
          num_model_requests: number;
          model: string | null;
          input_cached_tokens: number;
        }>;
      }>;
      has_more: boolean;
      next_page: string | null;
    }>;
  }

  // ─── Clicksign ──────────────────────────────────────────────────────────────

  async getClicksignConfig() {
    const baseUrl   = await this.get('CLICKSIGN_BASE_URL');
    const apiToken  = await this.get('CLICKSIGN_API_TOKEN');
    const webhookToken = await this.get('CLICKSIGN_WEBHOOK_TOKEN');
    return {
      baseUrl:       baseUrl      || process.env.CLICKSIGN_BASE_URL      || 'https://sandbox.clicksign.com',
      apiToken:      apiToken     || process.env.CLICKSIGN_API_TOKEN      || '',
      webhookToken:  webhookToken || process.env.CLICKSIGN_WEBHOOK_TOKEN  || '',
      isConfigured:  !!(apiToken  || process.env.CLICKSIGN_API_TOKEN),
    };
  }

  async setClicksignConfig(data: {
    baseUrl?: string;
    apiToken?: string;
    webhookToken?: string;
  }) {
    if (data.baseUrl      !== undefined) await this.set('CLICKSIGN_BASE_URL',      data.baseUrl);
    if (data.apiToken     !== undefined) await this.set('CLICKSIGN_API_TOKEN',     data.apiToken);
    if (data.webhookToken !== undefined) await this.set('CLICKSIGN_WEBHOOK_TOKEN', data.webhookToken);
  }

  // ─── Contrato Trabalhista — dados fixos ────────────────────────────────────

  async getContractConfig() {
    const raw = await this.get('CONTRACT_CONFIG');
    const defaults = {
      advogado1_nome:   'André Freire Lustosa',
      advogado1_oab:    'OAB/AL 14.209',
      advogado2_nome:   'Gianny Karla Oliveira Silva',
      advogado2_oab:    'OAB/AL 21.897',
      escritorio_logradouro: 'Rua Francisco Rodrigues Viana, nº 242, bairro Baixa Grande',
      escritorio_cidade: 'Arapiraca/AL',
      escritorio_cep:    '57307-260',
      foro:              'Arapiraca/AL',
      publicApiUrl:      process.env.PUBLIC_API_URL || '',
    };
    if (!raw) return defaults;
    try {
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return defaults;
    }
  }

  async setContractConfig(data: Record<string, string>) {
    const current = await this.getContractConfig();
    await this.set('CONTRACT_CONFIG', JSON.stringify({ ...current, ...data }));
  }

  // ─── TTS (Text-to-Speech) ─────────────────────────────────────────────────

  async getTtsConfig() {
    const enabled      = await this.get('TTS_ENABLED');
    const googleApiKey = await this.get('GOOGLE_TTS_API_KEY');
    const voice        = await this.get('TTS_VOICE');
    const language     = await this.get('TTS_LANGUAGE');
    return {
      enabled:      enabled === 'true',
      isConfigured: !!googleApiKey,
      voice:        voice    || 'pt-BR-Neural2-B',
      language:     language || 'pt-BR',
    };
  }

  async setTtsConfig(data: {
    enabled?: boolean;
    googleApiKey?: string;
    voice?: string;
    language?: string;
  }) {
    if (data.enabled !== undefined)  await this.set('TTS_ENABLED',        String(data.enabled));
    if (data.googleApiKey?.trim())   await this.set('GOOGLE_TTS_API_KEY', data.googleApiKey.trim());
    if (data.voice?.trim())          await this.set('TTS_VOICE',          data.voice.trim());
    if (data.language?.trim())       await this.set('TTS_LANGUAGE',       data.language.trim());
  }

  async getAiCosts() {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const start7Days = new Date(startOfToday);
    start7Days.setDate(start7Days.getDate() - 6);

    const prismaAny = this.prisma as any;

    // ── Dados locais (AiUsage) — tabela pode não existir ainda se migration não rodou ──
    let todayAgg: any = { _sum: { cost_usd: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 }, _count: { id: 0 } };
    let monthAgg: any = { _sum: { cost_usd: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 }, _count: { id: 0 } };
    let byModel:  any[] = [];
    let byType:   any[] = [];
    let daily:    any[] = [];

    try {
      [todayAgg, monthAgg, byModel, byType, daily] = await Promise.all([
        prismaAny.aiUsage.aggregate({
          _sum: { cost_usd: true, total_tokens: true, prompt_tokens: true, completion_tokens: true },
          _count: { id: true },
          where: { created_at: { gte: startOfToday } },
        }),
        prismaAny.aiUsage.aggregate({
          _sum: { cost_usd: true, total_tokens: true, prompt_tokens: true, completion_tokens: true },
          _count: { id: true },
          where: { created_at: { gte: startOfMonth } },
        }),
        prismaAny.aiUsage.groupBy({
          by: ['model'],
          _sum: { cost_usd: true, total_tokens: true },
          _count: { id: true },
          where: { created_at: { gte: startOfMonth } },
          orderBy: { _sum: { cost_usd: 'desc' } },
        }),
        prismaAny.aiUsage.groupBy({
          by: ['call_type'],
          _sum: { cost_usd: true, total_tokens: true },
          _count: { id: true },
          where: { created_at: { gte: startOfMonth } },
        }),
        prismaAny.aiUsage.groupBy({
          by: ['created_at'],
          _sum: { cost_usd: true, total_tokens: true },
          _count: { id: true },
          where: { created_at: { gte: start7Days } },
          orderBy: { created_at: 'asc' },
        }),
      ]);
    } catch (e: any) {
      // Tabela AiUsage ainda não existe — retorna zerados
      this.logger.warn(`[getAiCosts] Prisma falhou (tabela pode não existir): ${e?.message}`);
    }

    // Agrega últimos 7 dias por data (yyyy-mm-dd)
    const dailyMap: Record<string, { cost_usd: number; total_tokens: number; calls: number }> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(start7Days);
      d.setDate(d.getDate() + i);
      dailyMap[d.toISOString().slice(0, 10)] = { cost_usd: 0, total_tokens: 0, calls: 0 };
    }
    for (const row of daily) {
      const key = new Date(row.created_at).toISOString().slice(0, 10);
      if (dailyMap[key]) {
        dailyMap[key].cost_usd     += row._sum?.cost_usd     || 0;
        dailyMap[key].total_tokens += row._sum?.total_tokens || 0;
        dailyMap[key].calls        += row._count?.id         || 0;
      }
    }

    // ── Cotação USD→BRL (paralelo) ────────────────────────────────────────────
    const usdToBrl = await this.fetchUsdToBrl();

    // ── Dados reais da OpenAI (Admin Key) ────────────────────────────────────
    const adminKey = await this.get('OPENAI_ADMIN_KEY');

    let openai: {
      configured:           boolean;
      today_usd:            number | null;
      month_usd:            number | null;
      today_calls:          number | null;
      today_input_tokens:   number | null;
      today_output_tokens:  number | null;
      month_calls:          number | null;
      month_input_tokens:   number | null;
      month_output_tokens:  number | null;
      byModel:    Array<{ model: string; input_tokens: number; output_tokens: number; total_tokens: number; calls: number; cached_tokens: number; cost_usd: number }>;
      last7Days:  Array<{ date: string; cost_usd: number }>;
      error:      string | null;
    } = {
      configured: false,
      today_usd: null, month_usd: null,
      today_calls: null, today_input_tokens: null, today_output_tokens: null,
      month_calls: null, month_input_tokens: null, month_output_tokens: null,
      byModel: [], last7Days: [], error: null,
    };

    if (adminKey) {
      openai.configured = true;
      try {
        const startOfTodayTs = Math.floor(startOfToday.getTime() / 1000);
        const startOfMonthTs = Math.floor(startOfMonth.getTime() / 1000);
        const nowTs          = Math.floor(now.getTime() / 1000);

        // Usa apenas a usage API — custos são calculados pela tabela OPENAI_PRICE
        // (a /v1/organization/costs tem delay de billing de até 24h e pode retornar 0)
        const usageResp = await this.fetchOpenAiUsageByModel(startOfMonthTs, nowTs, adminKey);

        let monthUsd = 0, todayUsd = 0;
        let monthCalls = 0, todayCalls = 0;
        let monthIn = 0, monthOut = 0, todayIn = 0, todayOut = 0;

        const modelMap: Record<string, { input: number; output: number; requests: number; cached: number; cost: number }> = {};
        const dayUsdMap: Record<string, number> = {};

        for (const bucket of usageResp.data || []) {
          let bucketUsd = 0, bucketIn = 0, bucketOut = 0, bucketReqs = 0;

          for (const r of bucket.results || []) {
            const model = r.model || 'unknown';
            const cost  = estimateCostUsd(model, r.input_tokens || 0, r.output_tokens || 0);
            bucketUsd  += cost;
            bucketIn   += r.input_tokens        || 0;
            bucketOut  += r.output_tokens       || 0;
            bucketReqs += r.num_model_requests  || 0;
            if (!modelMap[model]) modelMap[model] = { input: 0, output: 0, requests: 0, cached: 0, cost: 0 };
            modelMap[model].input    += r.input_tokens        || 0;
            modelMap[model].output   += r.output_tokens       || 0;
            modelMap[model].requests += r.num_model_requests  || 0;
            modelMap[model].cached   += r.input_cached_tokens || 0;
            modelMap[model].cost     += cost;
          }

          const dayStr = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
          dayUsdMap[dayStr] = (dayUsdMap[dayStr] || 0) + bucketUsd;

          monthUsd   += bucketUsd;
          monthCalls += bucketReqs;
          monthIn    += bucketIn;
          monthOut   += bucketOut;

          if (bucket.start_time >= startOfTodayTs) {
            todayUsd   += bucketUsd;
            todayCalls += bucketReqs;
            todayIn    += bucketIn;
            todayOut   += bucketOut;
          }
        }

        openai.today_usd           = todayUsd;
        openai.month_usd           = monthUsd;
        openai.today_calls         = todayCalls;
        openai.today_input_tokens  = todayIn;
        openai.today_output_tokens = todayOut;
        openai.month_calls         = monthCalls;
        openai.month_input_tokens  = monthIn;
        openai.month_output_tokens = monthOut;

        openai.byModel = Object.entries(modelMap)
          .map(([model, v]) => ({
            model,
            input_tokens:  v.input,
            output_tokens: v.output,
            total_tokens:  v.input + v.output,
            calls:         v.requests,
            cached_tokens: v.cached,
            cost_usd:      v.cost,
          }))
          .sort((a, b) => b.total_tokens - a.total_tokens);

        // last7Days — 7 entradas fixas (com ou sem dados)
        openai.last7Days = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(start7Days);
          d.setDate(d.getDate() + i);
          const key = d.toISOString().slice(0, 10);
          openai.last7Days.push({ date: key, cost_usd: dayUsdMap[key] || 0 });
        }
      } catch (e: any) {
        openai.error = e?.message || 'Erro ao consultar OpenAI';
      }
    }

    return {
      usd_to_brl: usdToBrl,
      openai,
      today: {
        cost_usd:          todayAgg._sum.cost_usd          || 0,
        total_tokens:      todayAgg._sum.total_tokens      || 0,
        prompt_tokens:     todayAgg._sum.prompt_tokens     || 0,
        completion_tokens: todayAgg._sum.completion_tokens || 0,
        calls:             todayAgg._count.id              || 0,
      },
      month: {
        cost_usd:          monthAgg._sum.cost_usd          || 0,
        total_tokens:      monthAgg._sum.total_tokens      || 0,
        prompt_tokens:     monthAgg._sum.prompt_tokens     || 0,
        completion_tokens: monthAgg._sum.completion_tokens || 0,
        calls:             monthAgg._count.id              || 0,
      },
      byModel: byModel.map((r: any) => ({
        model:        r.model,
        cost_usd:     r._sum.cost_usd     || 0,
        total_tokens: r._sum.total_tokens || 0,
        calls:        r._count.id         || 0,
      })),
      byType: byType.map((r: any) => ({
        call_type:    r.call_type,
        cost_usd:     r._sum.cost_usd     || 0,
        total_tokens: r._sum.total_tokens || 0,
        calls:        r._count.id         || 0,
      })),
      last7Days: Object.entries(dailyMap).map(([date, v]) => ({ date, ...v })),
    };
  }
}
