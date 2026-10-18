// Disparos de RETORNO DE MANUTENÇÃO (chip da Clínica) — catálogo, regras e textos.
//
// Fonte única pra API (motor + Central de Disparos) e web (cards). Puro: sem banco.
//
// Pra cada tipo de procedimento (limpeza, clareamento, faceta de resina, lentes de
// porcelana) a clínica liga até 3 toques em volta da DATA PREVISTA do retorno — a mesma
// data do quadro Retornos (execução mais recente + meses do procedimento):
//
//   antes   → entra 15 dias antes  (janela até a véspera)   "está chegando"
//   no_dia  → entra na data         (janela de 7 dias)        "chegou a hora"
//   depois  → entra 15 dias depois  (janela até 45 dias)      "passou do prazo"
//
// Cada toque sai NO MÁXIMO 1 vez por ciclo (paciente + tipo + data prevista). Quem passa
// da última janela sai da régua (fica no "RETORNO ATRASADO" do quadro, pra contato manual)
// — ligar o disparo nunca despeja a carteira antiga de uma vez. Paciente com consulta
// marcada fica SUSPENSO (o agendamento já tem os avisos dele); fez o procedimento de novo
// → nova data prevista → ciclo novo.

export const RETORNO_FAMILIAS = ['limpeza', 'clareamento', 'faceta_resina', 'lentes_porcelana'] as const;
export type RetornoFamilia = (typeof RETORNO_FAMILIAS)[number];

export const RETORNO_ETAPAS = ['antes', 'no_dia', 'depois'] as const;
export type RetornoEtapa = (typeof RETORNO_ETAPAS)[number];

/** Nome do tipo nos cards da Central. */
export const RETORNO_FAMILIA_LABEL: Record<RetornoFamilia, string> = {
  limpeza: 'Limpeza dental',
  clareamento: 'Clareamento',
  faceta_resina: 'Facetas em resina',
  lentes_porcelana: 'Lentes de porcelana',
};

/** Como o procedimento aparece NO TEXTO ao paciente ({procedimento}). */
export const RETORNO_FAMILIA_TEXTO: Record<RetornoFamilia, string> = {
  limpeza: 'limpeza',
  clareamento: 'clareamento',
  faceta_resina: 'facetas de resina',
  lentes_porcelana: 'lentes de porcelana',
};

/**
 * Janela de cada toque em dias relativos à data prevista (hoje − prevista). Entra no
 * primeiro dia (`de`) e ainda sai até o último (`ate`) — folga pra fim de semana, feriado,
 * chip fora do ar ou teto do dia, sem nunca virar rajada.
 */
export const RETORNO_JANELAS: Record<RetornoEtapa, { de: number; ate: number }> = {
  antes: { de: -15, ate: -1 },
  no_dia: { de: 0, ate: 6 },
  depois: { de: 15, ate: 45 },
};

export const RETORNO_ETAPA_LABEL: Record<RetornoEtapa, string> = {
  antes: '15 dias antes',
  no_dia: 'no dia',
  depois: '15 dias depois',
};

export type RetornoDisparoId = `retorno_${RetornoFamilia}_${RetornoEtapa}`;

export const RETORNO_DISPARO_IDS: RetornoDisparoId[] = RETORNO_FAMILIAS.flatMap((f) =>
  RETORNO_ETAPAS.map((e) => `retorno_${f}_${e}` as RetornoDisparoId),
);

export function isRetornoDisparoId(id: string | null | undefined): id is RetornoDisparoId {
  return !!id && (RETORNO_DISPARO_IDS as string[]).includes(id);
}

export function retornoDisparoId(familia: RetornoFamilia, etapa: RetornoEtapa): RetornoDisparoId {
  return `retorno_${familia}_${etapa}`;
}

/** 'retorno_faceta_resina_no_dia' → { familia: 'faceta_resina', etapa: 'no_dia' }. */
export function parseRetornoDisparoId(id: RetornoDisparoId): { familia: RetornoFamilia; etapa: RetornoEtapa } {
  const etapa = RETORNO_ETAPAS.find((e) => id.endsWith(`_${e}`)) as RetornoEtapa;
  const familia = id.slice('retorno_'.length, id.length - etapa.length - 1) as RetornoFamilia;
  return { familia, etapa };
}

/** Liga/desliga (GlobalSetting por clínica). Default DESLIGADO: só 'true' liga. */
export function retornoToggleKey(id: RetornoDisparoId, tenantId: string): string {
  return `${id.toUpperCase()}_ENABLED_${tenantId}`;
}

/** Texto personalizado da clínica (TenantSetting). Vazio = texto-padrão. */
export function retornoTemplateKey(id: RetornoDisparoId): string {
  return `${id.toUpperCase()}_TEMPLATE`;
}

/** Freios do motor (anti-bloqueio do chip + não cansar o paciente). */
export const RETORNO_TETO_DIA = 40; // envios de retorno por clínica por dia
export const RETORNO_INTERVALO_PACIENTE_DIAS = 3; // entre 2 avisos de retorno/recall ao mesmo paciente
export const RETORNO_HORA_INICIO = 9; // 9:00 Maceió
export const RETORNO_HORA_FIM = 18; // até 17:59

/** Dia (YYYY-MM-DD, componentes UTC) de uma data — a convenção do app pra "dia". */
function diaUtc(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Dias inteiros de `prevista` até `hoje` (hoje − prevista; negativo = ainda vai chegar). */
export function diasDaPrevista(prevista: Date, hoje: Date): number {
  return Math.round((diaUtc(hoje) - diaUtc(prevista)) / 864e5);
}

/** Qual toque vale hoje pra essa data prevista (null = fora de todas as janelas). */
export function retornoEtapaDoDia(prevista: Date, hoje: Date): RetornoEtapa | null {
  const n = diasDaPrevista(prevista, hoje);
  for (const e of RETORNO_ETAPAS) {
    const j = RETORNO_JANELAS[e];
    if (n >= j.de && n <= j.ate) return e;
  }
  return null;
}

/** Quantos dias ainda restam na janela do toque (0 = último dia) — fila: quem vai perder primeiro. */
export function diasRestantesNaJanela(prevista: Date, hoje: Date, etapa: RetornoEtapa): number {
  return RETORNO_JANELAS[etapa].ate - diasDaPrevista(prevista, hoje);
}

/**
 * "Há quanto tempo" em português: "45 dias", "6 meses", "1 ano", "1 ano e 3 meses".
 * Meses de calendário completos (13/01 → 13/07 = 6 meses).
 */
export function tempoDesde(ultima: Date, hoje: Date): string {
  const dias = Math.max(0, Math.round((diaUtc(hoje) - diaUtc(ultima)) / 864e5));
  let meses =
    (hoje.getUTCFullYear() - ultima.getUTCFullYear()) * 12 + (hoje.getUTCMonth() - ultima.getUTCMonth());
  if (hoje.getUTCDate() < ultima.getUTCDate()) meses -= 1;
  if (meses < 2) return dias === 1 ? '1 dia' : `${dias} dias`;
  const anos = Math.floor(meses / 12);
  const resto = meses % 12;
  const txtMeses = (m: number) => (m === 1 ? '1 mês' : `${m} meses`);
  if (!anos) return txtMeses(meses);
  const txtAnos = anos === 1 ? '1 ano' : `${anos} anos`;
  return resto ? `${txtAnos} e ${txtMeses(resto)}` : txtAnos;
}

/** dd/mm/aaaa pelos componentes UTC (datas do app são naive-UTC). */
export function dataBr(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

export const RETORNO_VARIAVEIS: { key: string; desc: string }[] = [
  { key: 'nome', desc: 'Primeiro nome do paciente' },
  { key: 'tempo', desc: 'Há quanto tempo foi feito (ex.: 6 meses, 1 ano e 2 meses)' },
  { key: 'data_ultima', desc: 'Data em que foi feito (ex.: 13/07/2026)' },
  { key: 'data_prevista', desc: 'Data prevista do retorno (ex.: 13/01/2027)' },
  { key: 'procedimento', desc: 'O procedimento, como no texto (ex.: limpeza, lentes de porcelana)' },
  { key: 'clinica', desc: 'Nome da clínica' },
];

/** Troca as {variáveis}; desconhecida vira vazio; não deixa 3+ quebras seguidas. */
export function renderRetornoTemplate(tpl: string, vars: Record<string, string>): string {
  return (tpl || '')
    .replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Textos-padrão: curtos pra WhatsApp, informam QUANTO TEMPO faz, explicam o PORQUÊ
// (o que acontece com o que o paciente já tem se não cuidar) e terminam num convite
// simples. "antes" informa · "no dia" conscientiza · "depois" alerta com carinho e dá a
// saída ("se já fez em outro lugar, me avisa"). A clínica edita na Central.
export const DEFAULT_RETORNO_TEMPLATES: Record<RetornoDisparoId, string> = {
  retorno_limpeza_antes:
    'Oi, {nome}! 😊 Aqui é da equipe {clinica}.\n\n' +
    'Sua última limpeza foi há {tempo}, e a próxima já está chegando (dia {data_prevista}).\n\n' +
    'Com o tempo, a placa que a escova não alcança endurece e vira tártaro — ele só sai na limpeza profissional e, se fica, inflama a gengiva e abre caminho pra cárie entre os dentes.\n\n' +
    'Quer que eu já reserve um horário pra você?',
  retorno_limpeza_no_dia:
    'Oi, {nome}! Hoje completa o prazo da sua limpeza — já são {tempo} desde a última. 🦷\n\n' +
    'É nessa fase que o tártaro começa a se acumular junto da gengiva. Tirando agora, a limpeza é rápida, tranquila e evita sangramento, mau hálito e cárie.\n\n' +
    'Posso ver um horário pra você esta semana?',
  retorno_limpeza_depois:
    'Oi, {nome}, tudo bem? Passando porque sua limpeza está atrasada: a última foi há {tempo}.\n\n' +
    'Quanto mais tempo o tártaro fica, mais ele irrita a gengiva (ela sangra e pode retrair) e maior a chance de uma cárie escondida entre os dentes. Resolver cedo é sempre mais simples — e mais barato.\n\n' +
    'Vamos marcar? Se você já fez em outro lugar, me avisa que eu atualizo aqui. 💙',

  retorno_clareamento_antes:
    'Oi, {nome}! 😊 Aqui é da equipe {clinica}.\n\n' +
    'Já faz {tempo} do seu clareamento, e a manutenção está chegando (dia {data_prevista}).\n\n' +
    'Café, chá, vinho, refrigerante e molhos vão devolvendo a cor aos poucos. O retoque na hora certa mantém o branco com pouco esforço — bem antes de precisar refazer tudo.\n\n' +
    'Quer que eu já reserve um horário?',
  retorno_clareamento_no_dia:
    'Oi, {nome}! Hoje completa o prazo da manutenção do seu clareamento ({tempo} desde o último). ✨\n\n' +
    'É agora que o sorriso começa a perder o tom que você conquistou. Um retoque rápido devolve o branco e protege o investimento que você já fez.\n\n' +
    'Posso ver um horário pra você?',
  retorno_clareamento_depois:
    'Oi, {nome}, tudo bem? A manutenção do seu clareamento passou do prazo: já são {tempo} desde o último.\n\n' +
    'Os pigmentos voltam a entrar no esmalte e, quanto mais demora, mais sessões o retoque pede — e mais perto fica de ter que refazer o clareamento inteiro.\n\n' +
    'Vamos marcar? Se você já fez em outro lugar, me avisa que eu atualizo aqui. 💙',

  retorno_faceta_resina_antes:
    'Oi, {nome}! 😊 Aqui é da equipe {clinica}.\n\n' +
    'Suas facetas de resina completam {tempo}, e a revisão está chegando (dia {data_prevista}).\n\n' +
    'A resina sente o dia a dia: perde o brilho, pode manchar nas bordas e ter pequenos desgastes. Na revisão a gente faz o polimento e corrige qualquer detalhe antes que vire problema.\n\n' +
    'Quer que eu já reserve um horário?',
  retorno_faceta_resina_no_dia:
    'Oi, {nome}! Hoje é o dia da revisão das suas facetas de resina ({tempo} desde a última). 🦷\n\n' +
    'O polimento devolve o brilho, e conferir as bordas evita que a sujeira entre por baixo — é assim que começa a cárie escondida embaixo da faceta.\n\n' +
    'Posso ver um horário pra você?',
  retorno_faceta_resina_depois:
    'Oi, {nome}, tudo bem? A revisão das suas facetas passou do prazo: já são {tempo}.\n\n' +
    'Sem manutenção a resina perde cor e brilho, e uma borda que solta ou lasca deixa a placa entrar: vem mancha, infiltração e cárie no dente por baixo — e o reparo que era simples vira troca da faceta.\n\n' +
    'Vamos marcar? Se você já fez em outro lugar, me avisa que eu atualizo aqui. 💙',

  retorno_lentes_porcelana_antes:
    'Oi, {nome}! 😊 Aqui é da equipe {clinica}.\n\n' +
    'Suas lentes de porcelana completam {tempo}, e a revisão está chegando (dia {data_prevista}).\n\n' +
    'A porcelana não mancha, mas a gengiva e a borda da lente precisam de cuidado: é ali que a placa se acumula. Na revisão a gente faz a limpeza profissional e confere a cimentação e a mordida.\n\n' +
    'Quer que eu já reserve um horário?',
  retorno_lentes_porcelana_no_dia:
    'Oi, {nome}! Hoje completa o prazo da revisão das suas lentes ({tempo}). ✨\n\n' +
    'Cuidar agora mantém a gengiva saudável em volta das lentes (sem inflamar nem retrair) e garante que nada esteja forçando a porcelana — é isso que faz elas durarem muitos anos.\n\n' +
    'Posso ver um horário pra você?',
  retorno_lentes_porcelana_depois:
    'Oi, {nome}, tudo bem? A revisão das suas lentes passou do prazo: já são {tempo}.\n\n' +
    'Placa acumulada na borda inflama a gengiva, que pode retrair e deixar a margem aparecendo, e também causa cárie no dente embaixo da lente. Ranger ou apertar os dentes sem proteção pode trincar ou soltar a peça. Revisar cedo protege o investimento que você fez.\n\n' +
    'Vamos marcar? Se você já fez em outro lugar, me avisa que eu atualizo aqui. 💙',
};

/** Resumo do card na Central (quando entra + o que diz). */
export function retornoGatilho(etapa: RetornoEtapa): string {
  if (etapa === 'antes') return '15 dias antes da data prevista · informa que está chegando · suspende se agendar';
  if (etapa === 'no_dia') return 'Na data prevista · conscientiza e convida · suspende se agendar';
  return '15 dias depois · alerta o que pode prejudicar · suspende se agendar';
}
