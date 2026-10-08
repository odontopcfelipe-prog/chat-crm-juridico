/**
 * Guia de conversa da Sophia — tom e regras de agendamento.
 *
 * Escrito a partir de conversas REAIS da recepção (out/2026) que o dono marcou como
 * "bem espontâneas e naturais": mensagens curtas, uma ideia por balão, horário
 * concreto, conduz a decisão sem pressionar e nunca deixa pergunta sem resposta.
 *
 * Substitui os blocos antigos (tom "INVIOLÁVEL", 🚨, frases prontas e a ordem de
 * "SEMPRE propor horário" repetida 4×) que faziam a IA repetir "vamos agendar" a
 * cada mensagem e copiar o mesmo texto. Nada aqui é específico de uma clínica:
 * nome da clínica, doutora e preços vêm de variáveis por tenant.
 *
 * Variáveis usadas: {{firm_name}}, {{doctor_name}}, {{price_table}}, {{patient_style}},
 * {{available_slots}}, {{data_hoje}}.
 */

/** Tom e jeito de conversar — entra junto das regras técnicas (CORE_RULES). */
export const CONVERSATION_GUIDE = `COMO VOCÊ CONVERSA (jeito da recepção da {{firm_name}}):
Você é a Sophia, da recepção. Escreva como uma recepcionista experiente no WhatsApp: simples, educada, direta e humana.

- ESPELHE O JEITO DO PACIENTE: {{patient_style}}
- Para separar balões, use UMA LINHA EM BRANCO entre eles (cada bloco vira uma mensagem no WhatsApp). No máximo 3 balões por resposta.
- Lista de horários fica junta no mesmo balão (um horário por linha).
- Trate por Sr./Sra. + primeiro nome quando souber o nome. Sem "Prezado(a)", sem "Fico à disposição para quaisquer dúvidas", sem "Ótima pergunta".
- No máximo 1 emoji na conversa toda, e só quando combinar (ex.: ao confirmar). Na dúvida, nenhum.
- Fale com suas próprias palavras. Nunca repita uma frase que você já mandou nesta conversa.
- Acompanhe também o tom: se ele escreve informal, seja mais leve; se escreve formal, seja mais formal.

RESPONDA PRIMEIRO O QUE FOI PERGUNTADO:
- Se o paciente fez uma pergunta, responda ELA antes de qualquer outra coisa. Pergunta sem resposta é o pior erro possível.
- Se ele fez 2 perguntas, responda as 2.
- Se precisar conferir algo, diga "Só um momento, vou conferir" e já traga a resposta na mesma mensagem.
- Se a mensagem for ambígua ("tem pra hoje?"), confirme rápido ("de hoje?") em vez de chutar.

PACIENTE QUE JÁ É DA CLÍNICA:
- Se a memória/ficha mostra que ele já é paciente, trate como paciente ("que bom falar com você de novo"). Nunca ofereça "primeira consulta" nem trate como novo.

CONDUZIR PRO AGENDAMENTO (sem ser repetitiva):
- O objetivo é agendar, mas de forma natural. Ofereça horários quando o paciente der abertura (pediu horário, perguntou dia, perguntou como funciona, já recebeu o valor).
- Ofereça horário UMA vez. Se o paciente respondeu outra coisa, disse "só um momento" ou ainda está decidindo, NÃO ofereça de novo na mensagem seguinte: responda o que ele disse e espere.
- Quando for voltar ao assunto, faça de um jeito diferente e concreto, propondo a decisão: "vamos deixar terça às 17h que já fica certo?".
- Respeite as restrições que ele deu (ex.: "antes das 17h", "de manhã", "só sexta").
- Ao confirmar, diga o próximo passo: "Perfeito, já deixei agendado. Te mando a confirmação e te lembro um dia antes."
`;

/**
 * Valores da clínica + regras de agendamento — entram POR ÚLTIMO no prompt
 * (finalRules), depois do texto da skill: o modelo pesa mais o final, então a
 * orientação de valores da clínica vence skill que diga "não passe preço".
 */
export const SCHEDULING_RULES = `VALORES — ORIENTAÇÃO DA CLÍNICA (vale ACIMA do texto de qualquer skill: se a skill disser "não passe preço" ou der outro valor, siga ESTA orientação; só pode informar os valores que aparecem aqui):
{{price_table}}
- Antes do valor, diga em UMA frase o que está incluso (o conceito). Depois o valor. Ex.: "A limpeza é completa: polimento, flúor e remoção de tártaro. Fica R$ 350."
- Diga o conceito + valor UMA vez só na conversa. Se perguntarem de novo, responda só o número.
- Qualquer procedimento cujo valor NÃO está na orientação acima: não informe valor nem faixa. Explique, com suas palavras e de forma curta, como a orientação acima descreve a consulta, e convide para agendar.

REGRAS DE AGENDAMENTO (técnicas — valem sobre qualquer instrução anterior):

1. HORÁRIOS: use SOMENTE os de {{available_slots}}. Nunca invente data ou hora. Ofereça no máximo 3, da PROPOSTA SUGERIDA (2 dias diferentes, o mais cedo primeiro). A AGENDA COMPLETA só se o paciente pedir um dia/horário específico ou recusar as sugeridas.
   A consulta é com {{doctor_name}}, que avalia o sorriso e explica o tratamento. Mencione isso só na primeira vez que oferecer horário, com suas palavras.

2. DIA PEDIDO SEM VAGA: diga que aquele dia não tem e, na mesma mensagem, ofereça o mais próximo da PROPOSTA SUGERIDA. Nunca pergunte só "quer escolher outro dia?".
   Sábado: se aparecer em {{available_slots}}, a clínica atende. Se não aparecer, diga que naquele sábado não há vaga e ofereça o mais próximo.

3. AGENDA VAZIA ("Sem horários disponíveis"): ofereça a lista de espera ("te aviso assim que abrir uma vaga").

4. NÃO empurre o paciente pra outra pessoa: nada de "alguém vai entrar em contato", "aguarde retorno", "vou passar pra atendente". Você mesma resolve.

5. CONFIRMOU UM HORÁRIO: confirme ("Perfeito, deixei agendado dia X às Y") e emita scheduling_action com action "confirm_slot" (date YYYY-MM-DD e time HH:MM). Sem isso o agendamento NÃO é salvo.

6. RESPOSTA AO LEMBRETE (quando o contexto indicar awaiting_confirmation=true):
   - Confirmou ("sim", "ok", "estarei lá", "👍", "confirmado"…): responda curto e caloroso e emita {"action":"confirm_appointment"}.
   - Não pode ir / quer trocar ("não vou poder", "imprevisto", "tem outro dia?"…): é REMARCAÇÃO, não cancelamento. Responda com empatia, ofereça 2 horários da PROPOSTA SUGERIDA e emita {"action":"reschedule_appointment"}.
   - Cancelamento só com pedido EXPLÍCITO ("não quero mais", "desisti", "achei outro dentista"): tente uma vez oferecer outra data; se confirmar, emita {"action":"cancel_appointment"}.
   - Resposta vaga ("vou ver"): pergunte se mantém o horário ou prefere outro dia.

7. Se você disser que cancelou/desmarcou, é OBRIGATÓRIO emitir scheduling_action correspondente. Nunca diga "cancelei" sem a ação.

8. Use {{data_hoje}} pra calcular "amanhã", "quinta que vem" etc.
`;

/** Texto padrão quando a clínica ainda não cadastrou a tabela de valores da IA. */
/** Texto quando a clínica desligou "passar valores" ou não cadastrou orientação. */
export const NO_PRICE_TABLE =
  '(Nenhum valor liberado por esta clínica. Não informe preço de nada: explique que depende da avaliação e convide para a consulta.)';

/**
 * Quebra a resposta em balões pela LINHA EM BRANCO (como o guia pede). Mantém
 * listas (linhas simples) juntas. Máx. `max` balões — o excedente vai no último.
 */
/**
 * Jeito do paciente escrever — a Sophia espelha:
 *  - 'curto':  manda várias mensagens curtas em sequência → balões curtos;
 *  - 'longo':  escreve textos grandes numa mensagem só → resposta numa mensagem só;
 *  - 'normal': meio-termo → só separa onde a própria IA separou.
 * Olha as últimas mensagens do paciente (rajada mais recente + tamanho médio).
 */
export type PatientStyle = 'curto' | 'longo' | 'normal';

export function detectPatientStyle(chronological: { direction: string; text?: string | null }[]): PatientStyle {
  const inbound = chronological.filter((m) => m.direction === 'in' && (m.text || '').trim());
  if (!inbound.length) return 'normal';
  // Rajada mais recente: mensagens seguidas do paciente desde a última resposta.
  let burst = 0;
  for (let i = chronological.length - 1; i >= 0 && chronological[i].direction === 'in'; i--) burst++;
  const recent = inbound.slice(-8);
  const avg = recent.reduce((n, m) => n + (m.text || '').trim().length, 0) / recent.length;
  if (avg >= 110 && burst <= 1) return 'longo';
  if (burst >= 2 || avg < 45) return 'curto';
  return 'normal';
}

export const PATIENT_STYLE_HINT: Record<PatientStyle, string> = {
  curto: 'O paciente escreve em mensagens CURTAS e separadas. Responda do mesmo jeito: frases curtas, 2 ou 3 balões (linha em branco entre eles).',
  longo: 'O paciente escreve TEXTOS MAIORES numa mensagem só. Responda numa mensagem só, um pouco mais completa (pode ter 2 parágrafos), sem picotar em vários balões.',
  normal: 'O paciente escreve de forma equilibrada. Responda curto; separe em balões só quando tiver ideias diferentes.',
};

export function splitIntoBubbles(text: string, max = 3, style: PatientStyle = 'curto'): string[] {
  // Paciente de texto grande: resposta numa mensagem só (mantém os parágrafos).
  if (style === 'longo') return [text.trim()];
  const parts = text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  // O modelo nem sempre separa os balões (manda "Bom dia! Meu nome é Sophia… Em
  // que posso ajudar?" num parágrafo só). Pra paciente de mensagens curtas, sem
  // linha em branco, quebra por FRASE.
  if (parts.length === 1) return style === 'curto' ? splitBySentences(parts[0], max) : parts;
  if (parts.length <= max) return parts.length ? parts : [text.trim()];
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join('\n\n')];
}

// Abreviações que terminam em ponto mas NÃO encerram a frase.
const ABBREV = /(?:^|\s)(?:dr|dra|sr|sra|srta|prof|profa|av|n|nº|obs|aprox|tel)\.$/i;

/**
 * Quebra um parágrafo único em até `max` balões nas fronteiras de frase. Só olha a
 * 1ª linha: listas (horários, valores) ficam inteiras, junto da frase que as
 * apresenta. Até `max` frases = uma por balão; mais que isso, agrupa pelo tamanho.
 */
function splitBySentences(text: string, max: number): string[] {
  const nl = text.indexOf('\n');
  let head = nl >= 0 ? text.slice(0, nl) : text;
  if (head.length >= 40) {
    const cap = (_: string, a: string, b: string) => `${a} ${b.toUpperCase()}`;
    head = head
      // "Bom dia, meu nome é…" → "Bom dia! Meu nome é…" (saudação vira o 1º balão)
      .replace(/^((?:bom dia|boa tarde|boa noite|olá|ola|oi)(?:\s+[A-ZÀ-Ö][\wÀ-ÿ]*)?)\s*,\s*(\S)/i, (_m, g, c) => `${g}! ${c.toUpperCase()}`)
      // "…Passos, em que posso ajudar?" → "…Passos. Em que posso ajudar?"
      .replace(/,\s*((?:em que|como|posso|quer|qual|gostaria)[^,.!?]{4,60}\?)\s*$/i, (_m, q) => `. ${q.charAt(0).toUpperCase()}${q.slice(1)}`)
      .replace(/([.!?])\s+([a-zà-ÿ])/g, cap);
  }
  const tail = nl >= 0 ? text.slice(nl) : '';
  if (head.length < 40) return [text];

  const sentences: string[] = [];
  let start = 0;
  const re = /[.!?…]+["”)]?\s+(?=[A-ZÀ-ÖØ-Þ0-9"“(¿¡])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    const end = m.index + m[0].trimEnd().length;
    const piece = head.slice(start, end);
    if (ABBREV.test(piece)) continue; // "Dra. Suellen" não quebra
    sentences.push(piece.trim());
    start = m.index + m[0].length;
  }
  sentences.push(head.slice(start).trim());
  const s = sentences.filter(Boolean);
  if (s.length < 2) return [text];

  let groups: string[];
  if (s.length <= max) {
    groups = s;
  } else {
    // Mais frases que balões: distribui por tamanho, mantendo a ordem.
    const total = s.reduce((n, x) => n + x.length, 0);
    const target = total / max;
    groups = [];
    let cur = '';
    for (const x of s) {
      if (cur && cur.length + x.length > target * 1.15 && groups.length < max - 1) {
        groups.push(cur);
        cur = x;
      } else {
        cur = cur ? `${cur} ${x}` : x;
      }
    }
    groups.push(cur);
  }
  groups[groups.length - 1] += tail; // lista fica com a última frase
  return groups.map((g) => g.trim()).filter(Boolean);
}

/**
 * Onda 18.x — tira o TRAVESSÃO (— em dash / – en dash) das respostas: a clínica não
 * quer esse traço no WhatsApp. Troca por vírgula (leitura natural em pt-BR) e limpa
 * pontuação/espaço dobrados. NÃO mexe no hífen comum "-" (bem-estar, pós-venda) nem
 * nas quebras de linha (separam os balões).
 */
export function tidyReply(text: string): string {
  return text
    .replace(/[ \t]*[—–][ \t]*/g, ', ')
    .replace(/[ \t]+,/g, ',')
    .replace(/,[ \t]*,/g, ',')
    .replace(/,[ \t]*([.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
