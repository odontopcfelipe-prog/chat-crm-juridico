import type { AiReplyLength } from '@crm/shared';

/**
 * Guia de conversa da assistente da recepção (Sophia por padrão; o nome vem do
 * perfil do chip de cada clínica) — tom e regras de agendamento.
 *
 * Escrito a partir de conversas REAIS da recepção (out/2026) que o dono marcou como
 * "bem espontâneas e naturais": mensagens curtas, uma ideia por balão, horário
 * concreto, conduz a decisão sem pressionar e nunca deixa pergunta sem resposta.
 *
 * Substitui os blocos antigos (tom "INVIOLÁVEL", 🚨, frases prontas e a ordem de
 * "SEMPRE propor horário" repetida 4×) que faziam a IA repetir "vamos agendar" a
 * cada mensagem e copiar o mesmo texto. Nada aqui é específico de uma clínica:
 * nome da clínica, da assistente, contato, doutora e preços vêm de variáveis por
 * tenant (perfil do chip em Ajustes › IA — AI_PROFILE_<PURPOSE> — e cadastro da clínica).
 *
 * Variáveis usadas: {{assistant_name}}, {{firm_name}}, {{clinic_address}},
 * {{clinic_phone}}, {{clinic_hours}}, {{clinic_now}}, {{chip_instructions}}, {{doctor_name}},
 * {{price_table}}, {{patient_style}}, {{available_slots}}, {{data_hoje}}.
 */

/** Tom e jeito de conversar — entra junto das regras técnicas (CORE_RULES). */
export const CONVERSATION_GUIDE = `COMO VOCÊ CONVERSA (jeito da recepção da {{firm_name}}):
Você é a {{assistant_name}}, da recepção da {{firm_name}}. Escreva como uma recepcionista experiente no WhatsApp: simples, educada, direta e humana.

DADOS DA CLÍNICA (informe quando perguntarem; nunca invente):
- Endereço: {{clinic_address}}
- Telefone: {{clinic_phone}}
- Horário de atendimento: {{clinic_hours}}
- Situação agora: {{clinic_now}}

- TAMANHO E JEITO DAS RESPOSTAS: {{patient_style}}
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
 * Começa reafirmando a IDENTIDADE: as skills são globais e citam "Sophia do
 * Instituto Odonto Passos" fixo — aqui no final vale o nome/clínica DESTE tenant.
 */
export const SCHEDULING_RULES = `IDENTIDADE (vale acima de qualquer texto anterior):
- Seu nome é {{assistant_name}} e você fala pela {{firm_name}}. Se algum texto acima (skill/referência) usar outro nome de assistente ou de clínica, ignore e use estes.
- INSTRUÇÕES DA CLÍNICA PARA ESTE CANAL (siga): {{chip_instructions}}

CORREÇÕES DAS INSTRUÇÕES ANTIGAS DAS SKILLS (se o texto da skill ou das referências acima disser o contrário, IGNORE e siga isto):
1. Nome: NUNCA trave a conversa pedindo o nome primeiro. Responda o que o paciente disse; se ainda não souber o nome, pergunte de forma natural no fim da resposta.
2. Preço: siga só a orientação de VALORES abaixo. Ignore "respostas padrão" de preço da skill e qualquer valor escrito nela (inclusive "avaliação R$ 150 fixo"): o valor certo é o da orientação da clínica.
3. Encerramento: nunca "Precisando, é só me chamar", "fico à disposição" ou resposta vazia quando o paciente não agendou — siga a regra PACIENTE ENCERROU SEM AGENDAR.
4. "Não vou poder", "preciso desmarcar", "imprevisto", "tem outro dia?" = REMARCAÇÃO (ofereça 2 horários novos), NUNCA cancelamento. Só cancele com pedido explícito ("não quero mais", "desisti de vez", "achei outro dentista"). Nunca escreva "cancelei" sem que seja isso.
5. Endereço, telefone, horário e nome da clínica: informe com os DADOS DA CLÍNICA. Não diga "vou confirmar com a equipe" para o que já está nos dados.
6. Agendar: quando o paciente der abertura, ofereça horários concretos da PROPOSTA SUGERIDA — não pergunte "que dia da semana fica melhor?" sem oferecer horários. Toda skill pode agendar (inclusive a triagem).
7. "Vaga" só é emprego se a pessoa falar de trabalho/currículo; "tem vaga amanhã?" é HORÁRIO de consulta.
8. Antes de convidar para a avaliação, no máximo UMA pergunta de descoberta e uma frase de expectativa (durabilidade/etapas) quando fizer sentido — não faça questionário nem palestra.

JEITO DE ESCREVER (vale para TODAS as skills — se o texto da skill acima pedir outra coisa, siga ESTE bloco):
- Mensagens curtas, uma ideia por balão; linha em branco entre balões; no máximo 3. Espelhe o paciente: {{patient_style}}
- Responda primeiro o que ele perguntou. UMA pergunta sua por vez — nunca uma sequência de perguntas ou um "questionário".
- Fale com suas palavras: não copie modelos/roteiros da skill ao pé da letra e nunca repita uma frase que você já mandou nesta conversa.
- Nada de despedida que fecha a porta ("precisando, é só chamar", "fico à disposição", "qualquer dúvida estou aqui") enquanto o paciente não agendou.
- No máximo 1 emoji na conversa. Sem listas longas, sem negrito, sem textão técnico: se precisar explicar um tratamento, 1 ou 2 frases e convide para a avaliação.

VALORES — ORIENTAÇÃO DA CLÍNICA (vale ACIMA do texto de qualquer skill: se a skill disser "não passe preço" ou der outro valor, siga ESTA orientação; só pode informar os valores que aparecem aqui):
{{price_table}}
- Se o paciente perguntou o valor de um item que ESTÁ na orientação acima, INFORME o valor. Nunca diga "só depois da avaliação" pra um item que tem valor aqui.

COMO VENDER (jeito de vendedora da recepção — vale pra todas as skills):
1. CONSTRUA O VALOR ANTES DO PREÇO: descreva, com entusiasmo e detalhe, TUDO que está incluso (use o "o que está incluso" da orientação, com suas palavras). Mostre que é completo e cuidadoso, não uma lista seca.
2. DÊ O PREÇO COM NATURALIDADE, valorizando: "isso tudo fica apenas R$ 350".
3. FECHE COM UMA OFERTA LEVE DE AGENDA, sem pressão: "Posso dar uma olhada na agenda e ver se consigo pra essa semana?".
   Modelo de referência (o padrão de qualidade — adapte ao procedimento, não copie igual):
   "Nossa limpeza dental é completa: primeiro fazemos toda a remoção de tártaro, com raspagem em todos os dentes, inclusive a subgengival. Depois aplicamos flúor, fazemos o polimento de todos os dentes, a escovação e passamos fio dental em cada um. Tudo isso fica apenas R$ 350.

   Posso dar uma olhada na agenda e ver se consigo pra essa semana?"
- Faça isso UMA vez por procedimento. Se perguntarem de novo, responda só o valor.
- Procedimento cujo valor NÃO está na orientação acima: não informe valor nem faixa. Construa o valor da CONSULTA do mesmo jeito (o que é feito nela, segundo a orientação acima) e feche com a oferta de agenda.
- PROIBIDO frase genérica solta, sem construir o valor. Exemplos REAIS que não podem se repetir: "depende muito do que você vai precisar", "a consulta de avaliação a gente agenda sem compromisso", "só na avaliação a doutora consegue te dizer". Se o valor sai na avaliação, diga NA MESMA mensagem o que é feito na consulta e o que a pessoa ganha com ela (o plano certo pro caso dela). Se o paciente insistir no valor, não repita a mesma explicação: reconheça a pergunta com empatia e mostre de outro jeito por que a avaliação vale a pena.

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

9. PACIENTE ENCERROU SEM AGENDAR: vale quando ele NÃO tem consulta marcada e NÃO está respondendo a um lembrete (aí vale a regra 6). Sinais: respondeu só "ok", "obrigado(a)", "vou pensar", "depois vejo", "vou ver", "qualquer coisa eu chamo", "beleza", "tá bom", "entendi"…
   - NÃO feche a porta. PROIBIDO: "precisando, é só me chamar", "qualquer coisa estou à disposição", "fico à disposição", "estou por aqui", "quando quiser é só chamar" e despedidas ("tenha um ótimo dia", "até mais", "abraço").
   - Responda CURTO e caloroso (1 balão, sem pressão), mostrando que entendeu. Ex.: "Imagina, Felipe!" ou "Claro, pensa com calma." (com suas palavras).
   - NÃO ofereça horário nem pergunte de agenda nesta mesma mensagem: a tentativa de agendar vai SEPARADA, alguns minutos depois, enviada pelo sistema.
   - Marque retry_scheduling: true no respond_to_client (se responder em JSON: "retry_scheduling": true). Fora deste caso, não marque.
`;

/** Texto quando a clínica desligou "passar valores" ou não cadastrou orientação. */
export const NO_PRICE_TABLE =
  '(Nenhum valor liberado por esta clínica. Não informe preço nem faixa de nada. Quando perguntarem valor, construa o valor da CONSULTA de avaliação (o que é feito nela e o que a pessoa ganha) e explique que o valor do tratamento sai dali, com o plano certo pro caso dela; depois convide para a consulta. Nunca responda só "depende do caso".)';

// ─── 2ª TENTATIVA DE AGENDAMENTO ─────────────────────────────────────────────
// Paciente encerrou sem agendar ("ok", "vou pensar"): a IA responde curto SEM fechar
// a porta e, alguns minutos depois (perfil do chip: schedulingRetryMin), o sistema
// manda UMA mensagem separada oferecendo 2 horários. Helpers puros (sem banco) —
// usados no fluxo real e no chat de teste (dryRun).

/** Minúsculas e sem acento — os regex abaixo são ASCII (\b não entende "ã"). */
function plain(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Encerramento curto: "ok", "obrigada", "vou pensar", "depois vejo", "qualquer coisa eu chamo"…
const CLOSING_RE =
  /\b(ok(?:ay|ey|k+)?|blz|beleza|obrigad[oa]s?|obg|brigad[oa]|valeu|vlw|vou pensar|vou ver|vou analisar|vou avaliar|vou me organizar|depois (?:eu )?(?:vejo|veja|falo|te falo|retorno|chamo|te chamo)|qualquer coisa (?:eu )?(?:te |lhe )?(?:chamo|falo|aviso|procuro|retorno)|ta bom|ta certo|tudo bem|tranquilo|entendi|certo|show|joia|combinado)\b/;
// Ainda tem intenção/pergunta aberta — não é encerramento ("ok, tem amanhã?", "sim", "quero").
const OPEN_INTENT_RE =
  /\?|\b(?:horario|agend|marc|quando|amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|quanto|valor|preco|pode ser|quero|vamos|bora)|\bsim\b/;
// Recusa / pedido pra parar / já resolveu — NUNCA vira 2ª tentativa ("não, obrigado",
// "não tenho interesse", "desisti", "não me mande mais", "já marquei", "outro dentista").
const REFUSAL_RE =
  /\bnao\b|\bnem\b|desist|sem interesse|para(?:r)? de|me (?:tira|remov)|ja (?:fui|sou|marquei|agendei|fiz|tenho|resolvi|consegui)|outr[oa] (?:dentista|clinica|lugar)|cancel|bloque/;
// Saudação de abertura ("oi, tudo bem", "bom dia") — conversa começando, não encerrando.
const GREETING_RE = /^(?:oi+|ola|opa|e ai|eai|bom dia|boa tarde|boa noite|hello|hey)\b/;
// Só emoji de "ok" (👍, 🙏, 😊) também encerra.
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}\s]+$/u;

/**
 * A mensagem do paciente é um ENCERRAMENTO curto, sem pedido aberto? Rede de
 * segurança quando o modelo não marca retry_scheduling.
 */
export function isClosingWithoutScheduling(text: string | null | undefined): boolean {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 60) return false;
  if (EMOJI_ONLY_RE.test(raw)) return true;
  const t = plain(raw);
  if (REFUSAL_RE.test(t) || GREETING_RE.test(t)) return false;
  if (OPEN_INTENT_RE.test(t)) return false;
  return CLOSING_RE.test(t);
}

/**
 * A resposta da IA já propõe horário / oferece agenda? (data + hora, "quinta às 14h",
 * lista com "•", "quer que eu reserve", "posso olhar a agenda"…). Se sim, NÃO agenda
 * a 2ª tentativa — seria a mesma oferta repetida minutos depois.
 */
export function replyProposesSlots(text: string | null | undefined): boolean {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (raw.includes('•')) return true;
  const t = plain(raw);
  return (
    /\b\d{1,2}\/\d{1,2}\b[\s\S]*\b\d{1,2}(?:h|:\d{2})/.test(t) ||
    /\b(segunda|terca|quarta|quinta|sexta|sabado|amanha|hoje)\b[^.!?\n]{0,30}\b\d{1,2}(?:h\d{0,2}|:\d{2})\b/.test(t) ||
    // "às 14 horas", "a 9h" soltos e "quinta de manhã / sexta à tarde"
    /\b(?:as|a)\s+\d{1,2}\s*(?:h\b|horas?\b)/.test(t) ||
    /\b(segunda|terca|quarta|quinta|sexta|sabado|amanha)\b.{0,20}\b(?:de manha|a tarde|a noite|pela manha|pela tarde)\b/.test(t) ||
    /tenho\s+(?:essas?|esses?)\s+(?:opcoes|horarios)/.test(t) ||
    /(?:que\s+tal|posso\s+te?\s+encaixar|consigo\s+te?\s+encaixar|quer\s+que\s+eu\s+(?:reserve|agende|marque|veja)|posso\s+(?:dar\s+uma\s+olhada|olhar|ver|verificar|checar)\s+(?:na\s+|a\s+)?agenda|vamos\s+(?:deixar|agendar|marcar))/.test(
      t,
    )
  );
}

// Nomes que não são nome de gente (lead sem nome, teste) — não chama por eles.
const GENERIC_NAMES = new Set(['paciente', 'cliente', 'lead', 'contato', 'desconhecido', 'teste', 'sem']);

/** Primeiro nome "chamável" do lead ("felipe santos" → "Felipe"); null se não houver. */
export function leadFirstName(name: string | null | undefined): string | null {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]{2,}$/.test(first)) return null;
  if (GENERIC_NAMES.has(plain(first))) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Instrução interna da 2ª tentativa — SUBSTITUI a instrução normal do turno. A
 * última mensagem da conversa é nossa (de propósito): a IA volta por conta própria,
 * como a recepcionista que foi olhar a agenda.
 */
export function buildSchedulingRetryInstruction(firstName: string | null): string {
  const nameRule = firstName
    ? `Chame pelo primeiro nome: ${firstName}.`
    : 'Você não sabe o nome do paciente: não invente nome.';
  return `[INSTRUÇÃO INTERNA — não exiba ao cliente]
SEGUNDA TENTATIVA DE AGENDAMENTO. Alguns minutos atrás o paciente encerrou sem agendar e você já respondeu. Agora você volta por conta própria, como a recepcionista que foi olhar a agenda e voltou com uma proposta. Mande UMA mensagem nova, curta e natural (no máximo 2 balões, linha em branco entre eles):
- ${nameRule}
- Ofereça 2 horários concretos da PROPOSTA SUGERIDA (HORÁRIOS DISPONÍVEIS), em dias diferentes quando houver, o mais cedo primeiro, e pergunte se pode reservar um deles.
- NÃO repita valores, explicações nem perguntas que já estão na conversa. Nada de "como falei" ou "conforme te expliquei".
- Sem pressão nem urgência inventada, sem despedida, sem "fico à disposição".
- Não marque retry_scheduling e não emita scheduling_action.
- ESTA mensagem é a exceção às regras "não ofereça horário na mesma mensagem do encerramento" e "ofereça horário UMA vez": aqui você DEVE oferecer os 2 horários.
- Se algum horário já foi oferecido antes nesta conversa, ofereça OUTROS (use a AGENDA COMPLETA), para não repetir a mesma oferta.
Modelo do tom (adapte, não copie): "Felipe, olhei aqui a agenda: consigo quinta às 14h ou sexta às 9h pra sua avaliação. Quer que eu reserve uma?"`;
}

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

/**
 * Tamanho ESCOLHIDO pela clínica no perfil do chip (replyLength ≠ 'auto'): vence o
 * espelhamento do paciente. Chave = estilo efetivo (curta→curto, media→normal,
 * longa→longo).
 */
export const CLINIC_STYLE_HINT: Record<PatientStyle, string> = {
  curto: 'A clínica escolheu respostas CURTAS: frases curtas e diretas, 2 ou 3 balões (linha em branco entre eles), sem textão.',
  normal: 'A clínica escolheu respostas de tamanho MÉDIO: objetivas, com o essencial explicado; separe em balões só quando tiver ideias diferentes.',
  longo: 'A clínica escolheu respostas LONGAS: responda numa mensagem só, mais completa e explicada (pode ter 2 ou 3 parágrafos), sem picotar em vários balões.',
};

/**
 * Estilo EFETIVO da resposta: 'auto' espelha o paciente (detectPatientStyle);
 * 'curta' / 'media' / 'longa' = escolha da clínica no perfil do chip. Devolve o
 * estilo (usado no splitIntoBubbles) e o texto pra {{patient_style}}.
 */
export function resolveReplyStyle(
  replyLength: AiReplyLength,
  chronological: { direction: string; text?: string | null }[],
): { style: PatientStyle; hint: string; explicit: boolean } {
  const chosen: PatientStyle | null =
    replyLength === 'curta' ? 'curto' : replyLength === 'media' ? 'normal' : replyLength === 'longa' ? 'longo' : null;
  if (chosen) return { style: chosen, hint: CLINIC_STYLE_HINT[chosen], explicit: true };
  const detected = detectPatientStyle(chronological);
  return { style: detected, hint: PATIENT_STYLE_HINT[detected], explicit: false };
}

/**
 * Ritmo humano entre os balões (WhatsApp e chat de teste usam a MESMA conta —
 * cópia em apps/web/.../settings/ai/AiTestChatCard.tsx, manter igual):
 *  - "digitando..." proporcional ao tamanho: 0,9s + 45ms por caractere,
 *    entre 1,8s e 8s (uma pessoa digitando no celular);
 *  - antes do 2º/3º balão, uma pausa curta de "pensando" (0,6s a 1,2s).
 * Antes era 28ms/caractere com piso de 1,5s: os 3 balões chegavam quase juntos.
 */
export function bubbleTypingMs(bubble: string): number {
  return Math.min(Math.max(900 + bubble.length * 45, 1800), 8000);
}

export function bubblePauseMs(index: number): number {
  return index === 0 ? 0 : 600 + Math.round(Math.random() * 600);
}

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
