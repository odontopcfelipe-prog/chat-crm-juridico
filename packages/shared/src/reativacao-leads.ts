/**
 * Régua de REATIVAÇÃO de leads (follow-up do chip COMERCIAL) — catálogo único.
 *
 * Mesmo código pra todas as clínicas; cada clínica só liga e personaliza (Central
 * de Disparos › Configurações). Worker (planeja/escreve/envia), API (painel,
 * textos, liga/desliga) e tela leem as MESMAS chaves daqui.
 *
 * Como funciona (resumo):
 *   - Cada COLUNA do "Geral — Leads" (pipeline-general.ts) tem sua régua de toques
 *     (D0, D+3, D+7, D+14…). O planejador coloca na régua quem está PARADO naquela
 *     coluna (a clínica falou por último e o lead não respondeu há N dias).
 *   - Coluna LIGADA = aparece nos "Previstos" do painel (com o texto que sairia).
 *   - Envio LIGADO (chave geral) = os toques realmente saem pelo chip COMERCIAL.
 *   - Freios: 1 msg/dia por lead, seg–sáb 8h–19h (Maceió), 3–7 min entre envios
 *     por chip, teto diário, para na 1ª resposta / agendou / virou paciente /
 *     pediu pra parar; número sem WhatsApp sai da régua.
 *   - O texto é um MODELO: a IA reescreve pra cada lead com o histórico (nunca
 *     igual pra todos), mantendo o objetivo do toque.
 */
import type { GeneralStageKey } from './pipeline-general';

export type ReativacaoColuna = Extract<GeneralStageKey, 'novo' | 'conversa' | 'convite' | 'agendado' | 'orcamento'>;

export const REATIVACAO_COLUNAS: ReativacaoColuna[] = ['novo', 'conversa', 'convite', 'agendado', 'orcamento'];

export const REATIVACAO_COLUNA_LABEL: Record<ReativacaoColuna, string> = {
  novo: 'Novo contato',
  conversa: 'Em conversa',
  convite: 'Convite p/ avaliação',
  agendado: 'Faltou na avaliação',
  orcamento: 'Avaliação / orçamento',
};

/** Dias depois do 1º toque (D0) em que sai cada toque. índice 0 = toque 1. */
export const REATIVACAO_OFFSETS: Record<ReativacaoColuna, number[]> = {
  novo: [0, 3, 7, 14],
  conversa: [0, 3, 7],
  convite: [0, 3, 7],
  agendado: [0, 3, 7],
  orcamento: [0, 3, 8],
};

/** Dias mínimos PARADO (última msg da clínica sem resposta) pra entrar na régua. */
export const REATIVACAO_MIN_DIAS_PARADO: Record<ReativacaoColuna, number> = {
  novo: 1,
  conversa: 2,
  convite: 1,
  agendado: 0, // faltou: entra no dia seguinte ao NO_SHOW (regra própria no planejador)
  orcamento: 2,
};

/** Não reativa conversa parada há mais que isso (contato frio demais = risco de denúncia). */
export const REATIVACAO_MAX_DIAS_PARADO = 120;
/** Mesma coluna não volta pra régua do mesmo lead antes disso. */
export const REATIVACAO_RECICLO_DIAS = 90;
/** Teto diário padrão de toques ENVIADOS por clínica (chip Comercial). */
export const REATIVACAO_TETO_PADRAO = 30;
/** Janela de envio (hora local de Maceió) e dias (0=dom … 6=sáb). */
export const REATIVACAO_JANELA = { inicio: 8, fim: 19, dias: [1, 2, 3, 4, 5, 6] };
/** Intervalo entre dois envios no MESMO chip (anti-bloqueio), em minutos. */
export const REATIVACAO_INTERVALO_MIN = { min: 3, max: 7 };

/** Status do ciclo (LeadReactivation.status). */
export const REATIVACAO_STATUS = [
  'ATIVA', 'CONCLUIDA', 'RESPONDEU', 'AGENDOU', 'VIROU_PACIENTE', 'OPT_OUT',
  'SEM_WHATSAPP', 'MUDOU_ETAPA', 'HUMANO', 'CANCELADA',
] as const;
/** Status do toque (LeadDispatch.status). */
export const REATIVACAO_TOQUE_STATUS = ['AGENDADO', 'ENVIANDO', 'ENVIADO', 'CANCELADO', 'PULADO', 'FALHOU'] as const;

/**
 * Pediu pra parar — regra ESTRITA (grava o opt-out PERMANENTE): a mensagem INTEIRA
 * tem que ser o pedido, com no máximo "por favor/obrigado/no momento" e emoji no fim.
 * "Remover o siso", "Cancelar a consulta" ou "Não quero esperar muito" NÃO casam.
 */
export const REATIVACAO_OPT_OUT_RE =
  /^\s*(?:(?:por favor|pf|pfv)[,\s]+)?(?:par(?:e|em|a|ar|er) de (?:me )?(?:mandar|enviar|chamar|escrever|incomodar|ligar)(?: (?:mensage[mn]s?|msgs?|mais))*|pare|parem|parar|stop|sair|cancelar|descadastr\w*|remover|sem (?:mais )?interesse|n[aã]o (?:tenho )?(?:mais )?interesse|n[aã]o quero(?: mais)?(?: receber)?(?: (?:mensage[mn]s?|msgs?|contato))?|n[aã]o (?:me )?(?:mande|mandem|envie|enviem|chame|chamem)(?: mais)?(?: (?:mensage[mn]s?|msgs?))?|me (?:tira|tirem|remove|remova|retira)(?: d(?:a|essa|esta) lista)?)(?:[\s,.!;:-]+(?:por favor|pf|pfv|obrigad[oa]|valeu|mais|msgs?|mensagens?|no momento|agora|por enquanto|nisso|disso))*[\s.!?,;:\p{Extended_Pictographic}\u{FE0F}\u{200D}]*$/iu;

/**
 * Recusa — regra AMPLA (só pra NÃO mandar / encerrar o ciclo, nunca pra trancar o
 * contato pra sempre). Roda no texto normalizado (minúsculo, sem acento) e aceita
 * complemento e emoji: "Não tenho interesse no momento 🙏", "Me tira dessa lista",
 * "Pode parar de mandar mensagem". Na dúvida, pular é o lado seguro.
 */
export const REATIVACAO_RECUSA_RE =
  /\b(?:(?:nao|n) (?:tenho|tem|ha)(?: mais)? interesse|sem(?: mais)? interesse|nao (?:quero|desejo|preciso)(?: mais)? (?:receber|de (?:mensage|contato|ligac|propaganda|promoc)|que (?:me )?(?:mande|envie|chame|procure|entre))|nao quero mais\b|nao (?:me )?(?:mande|envie|chame|procure|incomode|ligue)\b|par(?:ar|[ae]m?) de (?:me )?(?:mandar|enviar|chamar|ligar|incomodar|procurar)|(?:me )?(?:tir[ae]m?|remov[ae]m?|exclu[ia]m?)(?: me)? d[aeo]s?s?[ae]? (?:lista|contatos?)|me (?:tira|tirem|remove|removam)\b|descadastr)/;

/** Minúsculo e sem acento (pra REATIVACAO_RECUSA_RE). */
export function normalizarParaRecusa(texto: string): string {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** A mensagem do lead é uma recusa (estrita OU ampla)? Textos longos não contam. */
export function ehRecusaDoLead(texto: string | null | undefined): boolean {
  const t = String(texto || '').trim();
  if (!t || t.length > 120) return false;
  return REATIVACAO_OPT_OUT_RE.test(t) || REATIVACAO_RECUSA_RE.test(normalizarParaRecusa(t));
}

/** Texto final de um toque (IA ou modelo) — o editor aceita no máximo isso. */
export const REATIVACAO_TEXTO_MAX = 700;

/** Tipos de Message que NÃO são conversa com o lead (nunca contam como "real"). */
export const REATIVACAO_TIPOS_MSG_INTERNA = ['note', 'internal_note', 'transfer_event'] as const;

// ─── Chaves (GlobalSetting, 'true' liga — padrão DESLIGADO) ──────────────────

/** Liga o ENVIO de verdade (sem isso a régua só planeja/mostra os Previstos). */
export const reativacaoEnvioKey = (tenantId: string) => `REATIVACAO_LEADS_ENABLED_${tenantId}`;
/** Liga a régua de UMA coluna (entra nos Previstos). */
export const reativacaoColunaKey = (coluna: ReativacaoColuna, tenantId: string) =>
  `REATIVACAO_${coluna.toUpperCase()}_ENABLED_${tenantId}`;

/** Ids usados no PATCH /followup/operacional/toggle (Central de Disparos). */
export const REATIVACAO_TOGGLE_IDS = ['reativacao_leads', ...REATIVACAO_COLUNAS.map((c) => `reativacao_${c}`)] as const;
export type ReativacaoToggleId = (typeof REATIVACAO_TOGGLE_IDS)[number];
export const isReativacaoToggleId = (id: string): id is ReativacaoToggleId =>
  (REATIVACAO_TOGGLE_IDS as readonly string[]).includes(id);
/** Chave GlobalSetting de um id de toggle da Central. */
export function reativacaoToggleKey(id: ReativacaoToggleId, tenantId: string): string {
  if (id === 'reativacao_leads') return reativacaoEnvioKey(tenantId);
  return reativacaoColunaKey(id.replace('reativacao_', '') as ReativacaoColuna, tenantId);
}

// ─── Personalização por clínica (TenantSetting) ──────────────────────────────

/** Teto diário (número em texto). */
export const REATIVACAO_TETO_KEY = 'REATIVACAO_TETO_DIA';
/** Texto-modelo de um toque. */
export const reativacaoModeloKey = (coluna: ReativacaoColuna, toque: number) =>
  `REATIVACAO_MODELO_${coluna.toUpperCase()}_${toque}`;

// ─── Textos-modelo padrão ────────────────────────────────────────────────────
// Balões separados por LINHA EM BRANCO. {valor_avaliacao}/{valor_limpeza} vêm da
// TABELA DE VALORES da clínica (Ajustes › IA) — sem o valor lá, a frase sai do texto.
// Variáveis: {nome} {interesse} {assunto}
// {gancho} {horario1} {horario2} {data} {hora} {clinica} {dentista}.
// A IA mantém o objetivo e reescreve com o histórico; só pode falar preço que
// já está no modelo (valores liberados da clínica).

export const DEFAULT_REATIVACAO_MODELOS: Record<ReativacaoColuna, string[]> = {
  novo: [
    'Oi, {nome}! Aqui é da recepção do {clinica} 😊\n\nVi que você chamou a gente sobre {interesse} e a conversa acabou ficando pela metade.\n\nQuer que eu veja um horário com a {dentista} pra você resolver isso com calma?',
    '{nome}, lembrei de você por causa de {interesse}.\n\n{gancho}\n\nPosso dar uma olhada na agenda e ver se consigo pra essa semana?',
    '{nome}, muita gente adia a avaliação por não saber como ela é, então te explico rapidinho.\n\nÉ uma consulta só: anamnese, fotos da face e do sorriso, escaneamento intraoral e a conversa com a {dentista}, que monta um plano sob medida pra você.\n\nTudo isso fica apenas {valor_avaliacao}, e você sai sabendo o que fazer e por onde começar.\n\nTenho {horario1} ou {horario2}. Qual fica melhor pra você?',
    '{nome}, sei que às vezes a gente adia o dentista com receio de ouvir que precisa fazer um monte de coisa.\n\nNa avaliação a {dentista} te mostra tudo nas fotos, explica as opções e você decide no seu tempo.\n\nFaz mais sentido eu ver um horário pra você agora, ou te chamar de novo no mês que vem?',
  ],
  conversa: [
    'Oi, {nome}! Lembrei da nossa conversa sobre {assunto} e quis retomar de onde a gente parou.\n\n[resposta curta e útil à dúvida que ficou em aberto]\n\nPosso dar uma olhada na agenda da {dentista} e ver se consigo pra essa semana?',
    '{nome}, fiquei pensando na nossa conversa sobre {interesse}.\n\n{gancho}\n\nO primeiro passo é a avaliação com a {dentista}: anamnese, fotos, escaneamento intraoral e um plano sob medida, tudo isso por apenas {valor_avaliacao}.\n\nQuer que eu veja um horário pra você essa semana?',
    '{nome}, separei dois horários com a {dentista} pensando em você.\n\nEla vai olhar com calma o que você me contou sobre {assunto} e montar um plano sob medida.\n\n{horario1} ou {horario2}: qual fica melhor pra você?',
  ],
  convite: [
    'Oi, {nome}! Imagino que aqueles horários que te passei não encaixaram na sua rotina.\n\nOlhei de novo a agenda da {dentista} e consegui {horario1} ou {horario2}.\n\nAlgum desses fica bom pra você?',
    '{nome}, queria te contar como é a avaliação aqui, pra você já chegar sabendo.\n\nTem anamnese, fotos da face e do sorriso, escaneamento intraoral e a conversa com a {dentista}, que monta um plano sob medida pra você.\n\nTudo isso fica apenas {valor_avaliacao}.\n\nFica melhor pra você de manhã ou à tarde? Eu procuro o encaixe na agenda.',
    '{nome}, não quero que você fique sem a sua avaliação por causa de horário 🙂\n\nSe essa semana estiver corrida, a gente olha a próxima com calma.\n\nPrefere que eu já reserve {horario1} pra você, ou que eu te mande opções da semana que vem?',
  ],
  agendado: [
    'Oi, {nome}! Vi que não deu pra você vir na sua avaliação de {data} às {hora}.\n\nEspero que esteja tudo bem com você. Imprevisto acontece com todo mundo, tá tudo certo 🙂\n\nJá separei {horario1} ou {horario2} pra remarcar. Qual fica melhor pra você?',
    '{nome}, lembrei de você porque sua avaliação era o primeiro passo pra resolver {assunto}.\n\nNela a {dentista} faz as fotos e o escaneamento, te explica tudo com calma e monta seu plano sob medida.\n\nQuer que eu veja um horário que encaixe melhor na sua rotina?',
    '{nome}, sei que às vezes a semana aperta e a gente adia o que é da gente.\n\nConsegui opções em outro período, caso o horário de antes tenha sido o problema: {horario1} ou {horario2}.\n\nQuer que eu reserve um deles, ou prefere que eu te chame no começo do mês que vem?',
  ],
  orcamento: [
    'Oi, {nome}! Foi muito bom te receber aqui.\n\nA {dentista} montou seu plano de {interesse} em cima do que ela viu na sua avaliação.\n\nO que ficou faltando pra gente começar: alguma dúvida do tratamento ou da forma de pagamento?',
    '{nome}, fiquei pensando no seu plano de {interesse}.\n\n{gancho}\n\nA forma de pagamento eu te explico com calma, pra achar o jeito que fica melhor pra você.\n\nPrefere que eu te explique por aqui ou numa ligação rápida?',
    '{nome}, olhei a agenda da {dentista} pensando no início do seu tratamento.\n\nEla já tem tudo do seu caso em mãos, então dá pra começar pela primeira etapa.\n\nTenho {horario1} ou {horario2}. Qual fica melhor pra você?',
  ],
};

/** O toque oferece 2 horários reais ({horario1}/{horario2})? */
export const reativacaoPedeHorarios = (modelo: string) => /\{horario1\}|\{horario2\}/.test(modelo);

/** Gancho de valor por funil (slug do Pipeline). Sem funil conhecido = genérico. */
export const REATIVACAO_GANCHOS: Record<string, string> = {
  odonto: 'Aqui a limpeza é completa: remoção de tártaro, raspagem em todos os dentes, raspagem subgengival, flúor, polimento, escovação e fio dental. Tudo isso fica apenas {valor_limpeza}.',
  implantes: 'Implante é pra você voltar a mastigar de tudo e sorrir sem esconder. É feito com anestesia local, no dia seguinte você já volta à rotina e, em alguns casos, dá pra sair com um dente provisório no mesmo dia.',
  ortodontia: 'Nunca é tarde pra alinhar os dentes: hoje tem alinhador quase invisível, e a manutenção leva de 20 a 30 minutos, dá pra encaixar no almoço ou no sábado.',
  protese: 'É pra você voltar a comer e sorrir sem medo da prótese soltar. O atendimento é reservado e, se quiser, você pode vir com alguém da família.',
  'estetica-facial': 'A ideia é realçar o que você já tem, sem transformar o seu rosto. Quem faz é dentista habilitado pelo CFO, com produto registrado na Anvisa.',
  'facetas-resina': 'Com facetas em resina dá pra ter um sorriso novo em 1 ou 2 consultas, geralmente sem desgastar os dentes, e com polimento elas duram de 5 a 8 anos.',
  clareamento: 'O clareamento aqui é feito com acompanhamento: a doutora escolhe a técnica certa pro seu caso, pensando também na sensibilidade, pra seus dentes ficarem mais brancos com tranquilidade.',
  'lentes-porcelana': 'Antes de decidir, você vê o resultado com o mock-up, um ensaio do sorriso novo direto na sua boca, e só então escolhe se quer seguir.',
};
export const REATIVACAO_GANCHO_GENERICO =
  'Na avaliação a doutora olha tudo com calma, tira suas dúvidas e monta um plano sob medida pra você.';

export function defaultReativacaoModelo(coluna: ReativacaoColuna, toque: number): string {
  return DEFAULT_REATIVACAO_MODELOS[coluna]?.[toque - 1] ?? '';
}

/** Preenche as variáveis de um modelo (prévia determinística / fallback sem IA). */
export function renderReativacaoModelo(modelo: string, vars: Partial<Record<string, string | null | undefined>>): string {
  return modelo.replace(/\{(\w+)\}/g, (m, k) => {
    const v = vars[k];
    return v != null && String(v).trim() ? String(v) : m;
  });
}

// ─── Preços: só o que a CLÍNICA liberou (Ajustes › IA › Valores) ─────────────

/** Valores em dinheiro citados ("R$ 150", "150 reais", "2 mil"), normalizados. */
export function extrairValoresDinheiro(texto: string): number[] {
  const out: number[] = [];
  const num = (int: string, dec?: string) => Number(`${int.replace(/\./g, '')}.${dec || '0'}`);
  let m: RegExpExecArray | null;
  const rs = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g;
  while ((m = rs.exec(texto))) out.push(num(m[1], m[2]));
  const reais = /(?<![\d,.$])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:reais|real)\b/gi;
  while ((m = reais.exec(texto))) out.push(num(m[1], m[2]));
  // "2 mil" (não "2 milímetros": \b do JS não vê acento como letra).
  const mil = /(?<![\d,.])(\d+)\s*mil(?![A-Za-zÀ-ÿ])/gi;
  while ((m = mil.exec(texto))) out.push(Number(m[1]) * 1000);
  return out;
}

/** Percentuais citados ("10%", "10 por cento"). */
export function extrairPercentuais(texto: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(?:%|por\s*cento)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) out.push(Number(m[1].replace(',', '.')));
  return out;
}

/**
 * Valores que a clínica LIBEROU pra IA falar: os R$ da tabela de valores dela
 * (TenantSetting AI_PRICE_TABLE). Valores desligados (AI_PRICES_ENABLED='false') ou
 * sem tabela = nenhum.
 */
export function precosLiberados(tabela: string | null | undefined, habilitado: boolean): Set<number> {
  if (!habilitado || !tabela) return new Set();
  return new Set(extrairValoresDinheiro(tabela));
}

/** Fim de frase (. ! ? + espaço), menos em abreviação ("com a Dra. Suellen"). */
const FIM_DE_FRASE = /(?<!\b(?:Dra|Dr|Sra|Sr|Prof|Profa|n[ºo])\.)(?<=[.!?])\s+/i;

/**
 * Tira do texto as FRASES com valor que a clínica não liberou (e o balão que ficar
 * vazio). Ex.: "…fio dental. Tudo isso fica apenas R$ 350." sem R$ 350 na tabela →
 * "…fio dental.". Onde o valor é liberado, o jeito de vender fica igual.
 */
export function removerPrecosNaoLiberados(texto: string, liberados: ReadonlySet<number>): string {
  const ok = (frase: string) => extrairValoresDinheiro(frase).every((v) => liberados.has(v));
  return String(texto || '')
    .split(/\n\s*\n/)
    .map((b) => b.split(FIM_DE_FRASE).filter(ok).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function formatarReais(v: number): string {
  const [int, dec] = v.toFixed(2).split('.');
  const milhar = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${milhar}${dec === '00' ? '' : `,${dec}`}`;
}

/**
 * {valor_avaliacao} e {valor_limpeza} a partir da TABELA DE VALORES da clínica
 * (TenantSetting AI_PRICE_TABLE, uma linha por item). Olha só o NOME do item (antes
 * de ":" / "—" / "(" / "R$"): "Clareamento: R$ 800 (a avaliação define…)" não é a
 * avaliação. Linha de "avaliação" manda — mesmo sem valor ("Avaliação: gratuita" =
 * vazio, nunca cai na "Consulta de urgência"); "consulta" só vale sem linha de
 * avaliação e nunca retorno/urgência/manutenção. Valores desligados ou item sem
 * linha = vazio (a frase do preço sai — ver removerFrasesComVariavelVazia).
 */
export function valoresPorProcedimento(
  tabela: string | null | undefined,
  habilitado: boolean,
): { valor_avaliacao: string; valor_limpeza: string } {
  const out = { valor_avaliacao: '', valor_limpeza: '' };
  if (!habilitado || !tabela) return out;
  const itens = String(tabela)
    .split(/\r?\n/)
    .map((linha) => ({
      nome: normalizarParaRecusa(linha.split(/[:—–(]|\s-\s|R\$/)[0]),
      valor: extrairValoresDinheiro(linha)[0],
    }));
  const primeiro = (casa: (nome: string) => boolean): string => {
    const achados = itens.filter((i) => casa(i.nome));
    const comValor = achados.find((i) => i.valor != null);
    return comValor ? formatarReais(comValor.valor as number) : '';
  };
  const naoEhAvaliacao = /retorno|urgenc|emergenc|manuten|controle|revis/;
  out.valor_avaliacao = itens.some((i) => /avalia/.test(i.nome))
    ? primeiro((n) => /avalia/.test(n))
    : primeiro((n) => /consulta/.test(n) && !naoEhAvaliacao.test(n));
  out.valor_limpeza = primeiro((n) => /limpeza|profilaxia/.test(n));
  return out;
}

/**
 * Tira as FRASES que usam uma variável {valor_*} sem valor (e o balão que ficar
 * vazio) — roda no modelo CRU, antes de preencher. Ex.: clínica sem limpeza na
 * tabela → "…fio dental. Tudo isso fica apenas {valor_limpeza}." vira "…fio dental.".
 */
export function removerFrasesComVariavelVazia(
  texto: string,
  vars: Partial<Record<string, string | null | undefined>>,
): string {
  const vazia = (frase: string) =>
    (frase.match(/\{(valor_\w+)\}/g) || []).some((m) => !String(vars[m.slice(1, -1)] ?? '').trim());
  return String(texto || '')
    .split(/\n\s*\n/)
    .map((b) => b.split(FIM_DE_FRASE).filter((f) => !vazia(f)).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

// ─── Variáveis comuns (worker e prévia da API usam as mesmas) ────────────────

/** "Implantes" → "implantes", "Odontologia Clínica" → "odontologia clínica" (sigla fica). */
export function interesseDoFunil(nomeFunil: string | null | undefined): string {
  const nome = String(nomeFunil || '').trim();
  if (!nome) return 'seu atendimento';
  return nome
    .split(/\s+/)
    .map((w) => (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/**
 * "Dra. <primeiro nome>" da orçamentista. Os modelos já trazem o artigo feminino
 * ("com a {dentista}"), então: sem nome → "doutora"; orçamentista homem ("Dr. X")
 * → "equipe de avaliação" (nunca "Dra." pra homem).
 */
export function dentistaDoModelo(nomeUsuario: string | null | undefined): string {
  const bruto = String(nomeUsuario || '').trim();
  if (/^dr\.?\s+/i.test(bruto)) return 'equipe de avaliação';
  const limpo = bruto.replace(/^(dra|dr\(a\))\.?\s+/i, '');
  const primeiro = limpo.split(/\s+/)[0] || '';
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]{2,}$/.test(primeiro)) return 'doutora';
  return `Dra. ${primeiro.charAt(0).toUpperCase()}${primeiro.slice(1).toLowerCase()}`;
}

