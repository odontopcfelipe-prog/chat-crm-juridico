/**
 * Disparos INTERNOS que vão pro WhatsApp de um membro da equipe (o telefone do
 * cadastro dele) — não pro paciente. Cada pessoa liga/desliga os que recebe no
 * cadastro da equipe; a clínica liga/desliga o disparo inteiro na Central.
 *
 * Gravado em User.disparos_off: os ids que a pessoa NÃO recebe. Vazio = recebe
 * todos os do papel dela (padrão de quem já existia antes deste controle).
 *
 * Os avisos aos ADMs (venda feita, novo agendamento, resumo do dia…) ainda vão pros
 * NÚMEROS de aviso configurados na Central (card "Venda feita"), não por pessoa.
 */

/** Quem é o público do disparo. */
export type PublicoDisparoEquipe = 'profissional' | 'todos';

export interface DisparoEquipe {
  id: string;
  nome: string;
  descricao: string;
  publico: PublicoDisparoEquipe;
}

export const DISPAROS_EQUIPE: readonly DisparoEquipe[] = [
  {
    id: 'resumo_dentista',
    nome: 'Agenda do dia',
    descricao: 'Toda manhã (8h), UMA mensagem com todos os atendimentos do dia dele. Não recebe aviso por paciente.',
    publico: 'profissional',
  },
  {
    id: 'task_alerts',
    nome: 'Alertas de tarefa',
    descricao: 'Tarefa dele vencendo em 30 min e o resumo das vencidas (8h e 14h).',
    publico: 'todos',
  },
];

export const DISPAROS_EQUIPE_IDS: readonly string[] = DISPAROS_EQUIPE.map((d) => d.id);

/** Profissional que atende (mesma regra do resumo do dentista): DENTIST, ou ADMIN com especialidade. */
export function ehProfissionalQueAtende(u: { roles?: string[] | null; specialties?: string[] | null }): boolean {
  const roles = u.roles || [];
  return roles.includes('DENTIST') || (roles.includes('ADMIN') && (u.specialties || []).length > 0);
}

/** Disparos que fazem sentido pro papel da pessoa (o que aparece no cadastro dela). */
export function disparosEquipeDoPapel(u: { roles?: string[] | null; specialties?: string[] | null }): DisparoEquipe[] {
  const prof = ehProfissionalQueAtende(u);
  return DISPAROS_EQUIPE.filter((d) => d.publico === 'todos' || (d.publico === 'profissional' && prof));
}

/** A pessoa recebe este disparo? (não desligou no cadastro da equipe) */
export function recebeDisparoEquipe(u: { disparos_off?: string[] | null } | null | undefined, id: string): boolean {
  return !(u?.disparos_off || []).includes(id);
}

/** Saneia o que veio da tela: só ids conhecidos, sem repetição. */
export function normalizarDisparosOff(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && DISPAROS_EQUIPE_IDS.includes(x))));
}
