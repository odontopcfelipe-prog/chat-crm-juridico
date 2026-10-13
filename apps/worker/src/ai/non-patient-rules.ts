import {
  isNonPatientCategory,
  nonPatientCategoryLabel,
  type NonPatientCategory,
} from '@crm/shared';
import { replyProposesSlots } from './conversation-guide';
import { findBookingClaims } from './scheduling-safety';

/**
 * "NÃO É CONSULTA" — helpers PUROS (sem banco) da triagem não-paciente no ai.processor.
 *
 * Duas fontes dizem que quem escreve não é paciente (emprego/currículo/entrevista,
 * fornecedor, negociação/contrato/reunião comercial, parceria, imprensa, spam):
 *  - o LLM de venda, pelo campo "nao_paciente" do JSON (regra SEMPRE ligada no prompt —
 *    SCHEDULING_RULES, correção 9 + FORMATO DA RESPOSTA);
 *  - o NonPatientClassifier (só com o toggle NAO_PACIENTE_TRIAGE_ENABLED_<t>).
 * E o Lead já marcado (Lead.non_patient_category) continua bloqueado nos turnos seguintes.
 * A marca só nasce no HANDOFF (toggle ligado: IA pausada; religar a IA desfaz). Com o
 * toggle desligado a marca do modelo vale só no turno (nota pra equipe), nunca é gravada.
 * Bloqueado = nunca oferece/marca horário: confirm_slot descartado, sem rede 13a, sem 2ª
 * tentativa. Princípio: na dúvida é PACIENTE (campo ausente/null/"PACIENTE"/texto livre/
 * categoria desconhecida = paciente).
 */

/** Marca de não-paciente vinda do modelo (categoria do shared + resumo de 1 frase). */
export interface NaoPacienteFlag {
  categoria: NonPatientCategory;
  resumo: string;
}

/** Minúsculas → MAIÚSCULAS sem acento ("Currículo" → "CURRICULO"; "nao_se_aplica" → "NAO SE APLICA"). */
function upperPlain(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/_+/g, ' ')
    .trim()
    .toUpperCase();
}

// Molde copiado do prompt ("CURRICULO|FORNECEDOR|…", "<1 frase>") — não é resposta.
const isPlaceholder = (s: string) => s.includes('|') || /^<[^>]*>$/.test(s) || /^\.+$/.test(s);

// "Não se aplica" / "paciente" / "nenhum" → o modelo disse que É paciente.
const PATIENT_VALUE_RE = /^(?:PACIENTE|LEAD|CLIENTE|NAO|NAO SE APLICA|NENHUMA?|NULL|NONE|FALSE|N\/A|-)$/;
// OUTRO (o "resto") com resumo que fala de paciente/lead ("Paciente pediu horário de
// avaliação", "não se aplica") é o modelo preenchendo o campo pra paciente → paciente.
const PATIENTISH_RESUMO_RE = /\b(?:PACIENTE|LEAD|NAO SE APLICA|NAO APLICAVEL)\b/;

// Sinônimos que o modelo usa no lugar do nome da categoria.
const CATEGORY_SYNONYMS: [RegExp, NonPatientCategory][] = [
  [/^(?:CV\b|EMPREGO|VAGA|TRABALHO|ENTREVISTA|ESTAGI|CANDIDAT|RH\b|RECRUT)/, 'CURRICULO'],
  [/^(?:VENDEDOR|VENDA|REPRESENTANTE|FORNECIMENTO|PRESTADOR)/, 'FORNECEDOR'],
  [/^(?:NEGOCI|CONTRATO|REUNIAO|IMPRENSA|JORNAL|REPORT|EVENTO|PATROCINI)/, 'NEGOCIO'],
  [/^(?:PARCERI|PARCEIRO|PERMUTA)/, 'PARCERIA'],
  [/^(?:PROPAGANDA|GOLPE|CORRENTE)/, 'SPAM'],
];

type CategoryReading =
  | { kind: 'cat'; cat: NonPatientCategory }
  | { kind: 'patient' }
  | { kind: 'empty' }
  | { kind: 'unknown' };

function readCategory(raw: unknown): CategoryReading {
  if (raw == null || raw === false || typeof raw === 'object') return { kind: 'empty' };
  const s = upperPlain(String(raw));
  if (!s || isPlaceholder(s)) return { kind: 'empty' };
  if (PATIENT_VALUE_RE.test(s)) return { kind: 'patient' };
  if (isNonPatientCategory(s)) return { kind: 'cat', cat: s };
  // Sinônimo só vale como NOME de categoria (até 3 palavras): "Trabalho na empresa X e
  // quero clareamento" é frase, não categoria.
  if (s.split(/\s+/).length <= 3) {
    for (const [re, cat] of CATEGORY_SYNONYMS) if (re.test(s)) return { kind: 'cat', cat };
  }
  return { kind: 'unknown' };
}

function cleanResumo(raw: unknown): string {
  if (raw == null || typeof raw === 'object') return '';
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s || isPlaceholder(s) || PATIENT_VALUE_RE.test(upperPlain(s))) return '';
  return s.slice(0, 200);
}

/** Categoria EXPLÍCITA → marca; OUTRO com resumo de paciente → paciente (null). */
function flagOf(cat: NonPatientCategory, rawResumo: unknown): NaoPacienteFlag | null {
  if (cat === 'OUTRO' && typeof rawResumo === 'string' && PATIENTISH_RESUMO_RE.test(upperPlain(rawResumo))) return null;
  return { categoria: cat, resumo: cleanResumo(rawResumo) };
}

// Na dúvida é PACIENTE: só marca com categoria EXPLÍCITA (do shared ou sinônimo
// conhecido) ou `true`. Texto livre, categoria desconhecida/vazia — mesmo com resumo
// ("é paciente", "não aplicável", {categoria:'', resumo:'lead quer implante'}) — é
// paciente: uma marca errada tira a agenda de quem queria marcar.
function normalizeFlag(raw: unknown, depth: number): NaoPacienteFlag | null {
  if (raw == null || raw === false || depth > 2) return null;
  if (raw === true) return { categoria: 'OUTRO', resumo: '' };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const n = normalizeFlag(item, depth + 1);
      if (n) return n;
    }
    return null;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    if (s.startsWith('{')) {
      try {
        return normalizeFlag(JSON.parse(s), depth + 1);
      } catch {
        return null;
      }
    }
    if (/^true$/i.test(s)) return { categoria: 'OUTRO', resumo: '' };
    const r = readCategory(s);
    return r.kind === 'cat' ? flagOf(r.cat, '') : null;
  }
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const r = readCategory(o.categoria ?? o.category ?? o.tipo ?? o.type);
  return r.kind === 'cat'
    ? flagOf(r.cat, o.resumo ?? o.summary ?? o.motivo ?? o.reason ?? o.descricao ?? o.description)
    : null;
}

/**
 * Extrai o "nao_paciente" do JSON da resposta (ou do input do respond_to_client): no
 * topo (contrato), dentro de `updates`, em camelCase, como string/JSON em string ou
 * `true`. Só categoria EXPLÍCITA (do shared ou sinônimo conhecido) marca; null /
 * "PACIENTE" / texto livre / categoria desconhecida ou vazia (mesmo com resumo) / molde
 * copiado = paciente (null).
 */
export function normalizeNaoPaciente(container: unknown): NaoPacienteFlag | null {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return null;
  const c = container as Record<string, any>;
  const upd =
    c.updates && typeof c.updates === 'object'
      ? c.updates
      : c.lead_update && typeof c.lead_update === 'object'
        ? c.lead_update
        : null;
  for (const cand of [c.nao_paciente, c.naoPaciente, c.non_patient, upd?.nao_paciente, upd?.naoPaciente, upd?.non_patient]) {
    const n = normalizeFlag(cand, 0);
    if (n) return n;
  }
  return null;
}

/** JSON malformado (fallback por regex do parseAiResponse): tenta achar o "nao_paciente". */
export function extractNaoPacienteFromRaw(raw: string | null | undefined): NaoPacienteFlag | null {
  const m = String(raw || '').match(/"nao_paciente"\s*:\s*(\{[^{}]*\}|"(?:[^"\\]|\\.)*"|true|false|null)/);
  if (!m) return null;
  try {
    return normalizeFlag(JSON.parse(m[1]), 0);
  } catch {
    return null;
  }
}

/** Decisão de bloqueio da agenda neste turno. */
export interface NonPatientBlock {
  /** Não oferece nem marca horário: descarta confirm_slot, sem rede 13a, sem 2ª tentativa. */
  blocked: boolean;
  categoria: NonPatientCategory | null;
  resumo: string;
  origem: 'modelo' | 'classificador' | 'lead' | null;
  /** Detectado AGORA (lead ainda não marcado): marca / alerta / handoff. false = já marcado (não repete). */
  novo: boolean;
}

/**
 * Junta as 3 fontes: lead JÁ marcado (não reclassifica nem alerta de novo), marca do
 * modelo neste turno, classificador. Cliente cadastrado (is_client): a marca antiga do
 * lead não vale (triagem errada que virou paciente) — só a deste turno. O caller só
 * passa `leadCategory` quando a marca vale (sem ficha de Paciente nem consulta marcada).
 * `modelSchedules`: o modelo, NO MESMO turno, marcou (confirm_slot) / ofereceu horário /
 * disse que agendou — sinal contraditório com a marca dele → na dúvida, PACIENTE.
 */
export function decideNonPatientBlock(input: {
  fromModel?: NaoPacienteFlag | null;
  fromClassifier?: { category?: string | null; reason?: string | null } | null;
  leadCategory?: string | null;
  isClient?: boolean;
  modelSchedules?: boolean;
}): NonPatientBlock {
  const fromModel = input.modelSchedules ? null : input.fromModel || null;
  const clsRaw = upperPlain(String(input.fromClassifier?.category || ''));
  const fromClassifier: NaoPacienteFlag | null =
    clsRaw && clsRaw !== 'PACIENTE'
      ? {
          categoria: isNonPatientCategory(clsRaw) ? clsRaw : 'OUTRO',
          resumo: cleanResumo(input.fromClassifier?.reason),
        }
      : null;
  const leadRaw = upperPlain(String(input.leadCategory || ''));
  if (leadRaw && !input.isClient) {
    return {
      blocked: true,
      categoria: isNonPatientCategory(leadRaw) ? leadRaw : 'OUTRO',
      resumo: fromModel?.resumo || fromClassifier?.resumo || '',
      origem: 'lead',
      novo: false,
    };
  }
  if (fromModel) return { blocked: true, ...fromModel, origem: 'modelo', novo: true };
  if (fromClassifier) return { blocked: true, ...fromClassifier, origem: 'classificador', novo: true };
  return { blocked: false, categoria: null, resumo: '', origem: null, novo: false };
}

/** Texto fixo de repasse (o mesmo do encerramento da triagem pelo classificador). */
export const NON_PATIENT_HANDOFF_TEXT =
  'Olá! Muito obrigada pelo contato. 😊 Aqui é o canal de atendimento aos pacientes, ' +
  'mas já vou encaminhar sua mensagem para o responsável, combinado? Qualquer retorno ' +
  'será por aqui. Tenha um ótimo dia!';

/** Turnos seguintes de quem JÁ foi marcado (a IA não repete a apresentação inteira). */
export const NON_PATIENT_FOLLOWUP_TEXT =
  'Já repassei sua mensagem para o responsável, combinado? O retorno será por aqui.';

// Menciona o repasse ("vou repassar", "encaminhar ao responsável", "setor de RH"…).
const REPASSE_RE = /\b(?:repass|encaminh|responsave|setor|gestor|gerencia|administra|diretori|direcao|dono|rh\b)/;
// Oferece/marca reunião, entrevista ou visita ("posso agendar uma entrevista", "reunião marcada").
const MEETING_RE =
  /\b(?:agend|marc|reserv)\w*\b[^.!?\n]{0,40}\b(?:reuniao|entrevista|visita|conversa|apresentacao)\b|\b(?:reuniao|entrevista|visita|apresentacao)\b[^.!?\n]{0,40}\b(?:agendad|marcad|reservad|confirmad)/;

const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * A resposta da IA serve pra quem NÃO é paciente? Não oferece horário, não diz que
 * marcou nada, não agenda reunião/entrevista e (com `requireRepasse`) avisa o repasse.
 */
export function isAdequateNonPatientReply(
  reply: string | null | undefined,
  opts: { requireRepasse?: boolean } = {},
): boolean {
  const t = String(reply || '').trim();
  if (!t) return false;
  if (replyProposesSlots(t)) return false;
  if (findBookingClaims(t).length) return false;
  const p = plain(t);
  if (MEETING_RE.test(p)) return false;
  if (opts.requireRepasse && !REPASSE_RE.test(p)) return false;
  return true;
}

/**
 * A marca "nao_paciente" do modelo contradiz o que ele mesmo fez no turno? Emitiu
 * confirm_slot, ofereceu horário de consulta ou disse que agendou → na dúvida, PACIENTE.
 * Oferecer reunião/entrevista/visita combina com não-paciente: não contradiz.
 */
export function contradictsNonPatient(reply: string | null | undefined, opts: { confirmSlot?: boolean } = {}): boolean {
  if (opts.confirmSlot) return true;
  const t = String(reply || '').trim();
  if (!t || MEETING_RE.test(plain(t))) return false;
  return replyProposesSlots(t) || findBookingClaims(t).length > 0;
}

/**
 * Resposta final pra quem não é paciente: a da IA quando adequada; senão o texto fixo
 * de repasse (no 1º turno) ou o lembrete curto (lead já marcado).
 * `requireRepasse` = handoff com pausa (toggle ligado): a resposta TEM que dizer que repassa.
 */
export function chooseNonPatientReply(
  aiReply: string | null | undefined,
  opts: { requireRepasse: boolean; alreadyMarked: boolean },
): { text: string; replaced: boolean } {
  if (isAdequateNonPatientReply(aiReply, { requireRepasse: opts.requireRepasse })) {
    return { text: String(aiReply).trim(), replaced: false };
  }
  return { text: opts.alreadyMarked ? NON_PATIENT_FOLLOWUP_TEXT : NON_PATIENT_HANDOFF_TEXT, replaced: true };
}

/** Aviso aos ADMs (WhatsApp) — handoff com a IA pausada. */
export function buildNonPatientAdminText(p: {
  assistantName: string;
  categoria: string;
  nome: string;
  telefone?: string | null;
  resumo?: string | null;
  trecho?: string | null;
}): string {
  const resumo = String(p.resumo || '').trim();
  const trecho = String(p.trecho || '').trim().slice(0, 300);
  return (
    `🔔 *Contato não-paciente na ${p.assistantName} (Comercial)*\n\n` +
    `Tipo: *${nonPatientCategoryLabel(p.categoria)}*\n` +
    `Contato: *${p.nome}*${p.telefone ? ` (${p.telefone})` : ''}\n` +
    (resumo ? `Resumo: ${resumo}\n` : '') +
    (trecho ? `Mensagem: "${trecho}"\n` : '') +
    `\nA IA respondeu que vai repassar ao responsável e foi pausada nessa conversa. ` +
    `Assumam pelo painel para dar o retorno. Se for paciente, religuem a IA da conversa (isso desfaz a marca).`
  );
}

/** Nota interna (sem pausar a IA): toggle da triagem desligado ou chip/contato sem handoff. */
export function buildNonPatientTeamNote(p: {
  categoria: string;
  resumo?: string | null;
  trecho?: string | null;
  /** Lead JÁ marcado pela triagem (handoff) e a resposta com horário foi trocada pelo repasse. */
  alreadyMarked?: boolean;
}): string {
  const resumo = String(p.resumo || '').trim();
  const trecho = String(p.trecho || '').trim().slice(0, 200);
  const tipo = nonPatientCategoryLabel(p.categoria);
  const corpo = p.alreadyMarked
    ? `⚠️ IA: este contato está MARCADO como não-paciente (${tipo}) pela triagem, então a IA não oferece nem marca ` +
      `horário pra ele: a resposta desta mensagem foi trocada pelo aviso de repasse. Se for paciente, desliguem e ` +
      `religuem a IA desta conversa (isso desfaz a marca); senão, deem o retorno pelo painel.`
    : `⚠️ IA: este contato parece NÃO ser paciente (${tipo})${resumo ? `: ${resumo}` : ''}. ` +
      `A IA não ofereceu nem marcou horário nesta resposta e continua ligada (o contato NÃO fica marcado): ` +
      `deem o retorno pelo painel. Se for paciente, sigam normalmente.`;
  return corpo + (trecho ? `\nÚltima mensagem: "${trecho}"` : '');
}

/** Legenda do arquivo encaminhado aos ADMs (mesmo formato do webhook da API). */
export function buildNonPatientAttachmentCaption(p: {
  nome: string;
  categoria: string;
  telefone?: string | null;
  caption?: string | null;
}): string {
  return (
    `📎 Arquivo de ${p.nome} (${nonPatientCategoryLabel(p.categoria)})` +
    (p.telefone ? `\nTel: ${p.telefone}` : '') +
    (p.caption ? `\nMensagem: "${String(p.caption).slice(0, 300)}"` : '')
  );
}

/** Tipo/nome do anexo pro sendAdminAlert (imagem vai como imagem; o resto como documento). */
export function nonPatientAttachmentMeta(m: {
  type?: string | null;
  mime?: string | null;
  originalName?: string | null;
}): { mediatype: 'image' | 'document'; mimetype: string | null; fileName: string } {
  const mimetype = String(m.mime || '').split(';')[0].trim() || null;
  const ext = (mimetype?.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  return {
    mediatype: m.type === 'image' ? 'image' : 'document',
    mimetype,
    fileName: String(m.originalName || '').trim() || `arquivo.${ext}`,
  };
}
