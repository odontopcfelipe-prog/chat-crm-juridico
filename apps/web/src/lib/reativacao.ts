/**
 * Régua de REATIVAÇÃO de leads (follow-up do chip COMERCIAL) — o que a TELA usa.
 *
 * CÓPIA de partes de packages/shared/src/reativacao-leads.ts (componente client não
 * pode importar '@crm/shared': o index cria um PrismaClient) — manter igual.
 * Aqui fica só o que o painel do CRC e a Central de Disparos precisam: colunas,
 * rótulos, toques (offsets), freios (texto informativo) e os modelos padrão (que o
 * editor mostra se a API falhar). Quem decide o que sai é o worker, com o shared.
 */
import { GENERAL_STAGES } from './pipeline-general';

export type ReativacaoColuna = 'novo' | 'conversa' | 'convite' | 'agendado' | 'orcamento';

export const REATIVACAO_COLUNAS: ReativacaoColuna[] = ['novo', 'conversa', 'convite', 'agendado', 'orcamento'];

export const isReativacaoColuna = (v: string | null | undefined): v is ReativacaoColuna =>
  !!v && (REATIVACAO_COLUNAS as string[]).includes(v);

export const REATIVACAO_COLUNA_LABEL: Record<ReativacaoColuna, string> = {
  novo: 'Novo contato',
  conversa: 'Em conversa',
  convite: 'Convite p/ avaliação',
  agendado: 'Faltou na avaliação',
  orcamento: 'Avaliação / orçamento',
};

/** Cor da coluna = a mesma da coluna do "Geral — Leads" no CRC (pipeline-general). */
export const REATIVACAO_COLUNA_COR: Record<ReativacaoColuna, string> = Object.fromEntries(
  REATIVACAO_COLUNAS.map((c) => [c, GENERAL_STAGES.find((g) => g.key === c)?.color ?? '#6b7280']),
) as Record<ReativacaoColuna, string>;

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

/** Teto diário padrão de toques ENVIADOS por clínica (chip Comercial). */
export const REATIVACAO_TETO_PADRAO = 30;
/** Janela de envio (hora local de Maceió) e dias (0=dom … 6=sáb). */
export const REATIVACAO_JANELA = { inicio: 8, fim: 19, dias: [1, 2, 3, 4, 5, 6] };
/** Intervalo entre dois envios no MESMO chip (anti-bloqueio), em minutos. */
export const REATIVACAO_INTERVALO_MIN = { min: 3, max: 7 };
/**
 * Tamanho máximo do texto de um toque (= REATIVACAO_TEXTO_MAX do shared). A API
 * recusa modelo maior e o worker recusa texto maior — o editor limita no mesmo valor.
 */
export const REATIVACAO_TEXTO_MAX = 700;

/** "D0", "D+3"… do toque (1-based). */
export function reativacaoToqueDia(coluna: ReativacaoColuna, toque: number): string {
  const off = REATIVACAO_OFFSETS[coluna]?.[toque - 1];
  if (off == null) return '';
  return off === 0 ? 'D0' : `D+${off}`;
}

/** Rótulo da aba do editor: "1º toque (D0)", "2º toque (D+3)"… */
export function reativacaoToqueLabel(coluna: ReativacaoColuna, toque: number): string {
  return `${toque}º toque (${reativacaoToqueDia(coluna, toque)})`;
}

/** Resumo dos toques de uma coluna pro card: "3 toques: D0 · D+3 · D+7". */
export function reativacaoToquesResumo(coluna: ReativacaoColuna): string {
  const offs = REATIVACAO_OFFSETS[coluna] || [];
  return `${offs.length} toques: ${offs.map((_, i) => reativacaoToqueDia(coluna, i + 1)).join(' · ')}`;
}

// ─── Textos-modelo padrão (fallback do editor — a API devolve o da clínica) ───
// Balões separados por LINHA EM BRANCO. {valor_avaliacao}/{valor_limpeza} vêm da
// TABELA DE VALORES da clínica (Ajustes › IA) — sem o valor lá, a frase sai do texto.
// Variáveis: {nome} {interesse} {assunto}
// {gancho} {horario1} {horario2} {data} {hora} {clinica} {dentista}.

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

export const REATIVACAO_GANCHO_GENERICO =
  'Na avaliação a doutora olha tudo com calma, tira suas dúvidas e monta um plano sob medida pra você.';

export function defaultReativacaoModelo(coluna: ReativacaoColuna, toque: number): string {
  return DEFAULT_REATIVACAO_MODELOS[coluna]?.[toque - 1] ?? '';
}

/** Quebra um texto em balões (o worker manda um balão por bloco separado por linha em branco). */
export function reativacaoBaloes(texto: string | null | undefined): string[] {
  return (texto || '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}
