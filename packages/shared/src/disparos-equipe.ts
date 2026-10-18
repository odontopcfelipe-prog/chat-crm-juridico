import { normalizeBrazilianPhone, toAlertPhone } from './phone.util';

/**
 * Disparos INTERNOS que vão pro WhatsApp de um membro da equipe (o telefone do
 * cadastro dele) — não pro paciente. Cada pessoa liga/desliga os que recebe no
 * cadastro da equipe; a clínica liga/desliga o disparo inteiro na Central.
 *
 * Cada papel vê os do seu nicho: o dentista a agenda dele, o ADM os avisos da
 * clínica (venda feita, resumo do dia, novo agendamento, não-paciente…), todos os
 * alertas de tarefa.
 *
 * Quem recebe (recebeDisparoEquipe):
 *   - User.disparos_off = ids que a pessoa DESLIGOU — vale sobre tudo (até sobre o
 *     número dela digitado na Central);
 *   - `padrao: true`  → recebe sem precisar marcar (a agenda do dentista, tarefas e o
 *     "sem agendamento", que já iam pra todo ADM);
 *   - `padrao: false` → só quem foi ADICIONADO pra receber: marcado no cadastro
 *     (User.disparos_on) ou com o número na lista da Central (`central`).
 */

/** Quem é o público do disparo. */
export type PublicoDisparoEquipe = 'profissional' | 'admin' | 'todos';

/**
 * Lista de números da Central que também recebe o disparo:
 *   'aviso'         = VENDA_FEITA_PHONE_<t> (vazio → herda o do Resumo diário);
 *   'resumo_diario' = DAILY_SUMMARY_PHONE_<t> (card do Resumo diário).
 */
export type CentralDisparoEquipe = 'aviso' | 'resumo_diario';

export interface DisparoEquipe {
  id: string;
  nome: string;
  descricao: string;
  publico: PublicoDisparoEquipe;
  /** Grupo na tela do cadastro (o "nicho" do aviso). */
  nicho: string;
  /** true = recebe sem marcar (só sai quem desligar); false = só quem for adicionado. */
  padrao: boolean;
  /** Números da Central que também recebem (ausente = só as pessoas do cadastro). */
  central?: CentralDisparoEquipe;
}

export const DISPAROS_EQUIPE: readonly DisparoEquipe[] = [
  {
    id: 'resumo_dentista',
    nome: 'Agenda do dia',
    descricao: 'Toda manhã (8h), UMA mensagem com todos os atendimentos do dia dele. Não recebe aviso por paciente.',
    publico: 'profissional',
    nicho: 'Atendimento',
    padrao: true,
  },
  {
    id: 'task_alerts',
    nome: 'Alertas de tarefa',
    descricao: 'Tarefa dele vencendo em 30 min e o resumo das vencidas (8h e 14h).',
    publico: 'todos',
    nicho: 'Tarefas',
    padrao: true,
  },
  // ── Avisos aos ADMs (os ids são os mesmos dos cards da Central de Disparos) ──
  {
    id: 'venda_feita',
    nome: 'Venda feita',
    descricao: 'A cada venda: paciente, valor, forma de pagamento, itens e quem vendeu.',
    publico: 'admin',
    nicho: 'Vendas e financeiro',
    padrao: false,
    central: 'aviso',
  },
  {
    id: 'resumo_diario',
    nome: 'Resumo diário do dia',
    descricao: 'Uma vez por dia (horário da Central): entradas, saídas, vendas de boleto e negociações do dia anterior.',
    publico: 'admin',
    nicho: 'Vendas e financeiro',
    padrao: false,
    central: 'resumo_diario',
  },
  {
    id: 'carla_escalonamento',
    nome: 'Financeiro precisa de você (IA)',
    descricao: 'A IA do Financeiro passou um caso pra equipe resolver. Se o chip Financeiro escolher pessoas, vai só pra elas.',
    publico: 'admin',
    nicho: 'Vendas e financeiro',
    padrao: false,
    central: 'aviso',
  },
  {
    id: 'admin_agendamento_ia',
    nome: 'Agendamento feito pela IA',
    descricao: 'A cada consulta que a IA marcar: paciente, dia e hora, tipo e dentista.',
    publico: 'admin',
    nicho: 'Agenda da clínica',
    padrao: false,
    central: 'aviso',
  },
  {
    id: 'admin_agendamento_equipe',
    nome: 'Agendamento feito pela equipe',
    descricao: 'A cada consulta que alguém da equipe marcar: paciente, dia e hora, dentista e quem marcou.',
    publico: 'admin',
    nicho: 'Agenda da clínica',
    padrao: false,
    central: 'aviso',
  },
  {
    id: 'pacientes_sem_agendamento',
    nome: 'Pacientes sem agendamento',
    descricao: 'Às 8h: quem fechou e não agendou, em tratamento sem próxima consulta e em stand by.',
    publico: 'admin',
    nicho: 'Agenda da clínica',
    padrao: true,
  },
  {
    id: 'pacientes_sem_agendamento_orto',
    nome: 'Ortodontia sem agendamento',
    descricao: 'Às 8h: pacientes de ortodontia sem próxima consulta, por dentista.',
    publico: 'admin',
    nicho: 'Agenda da clínica',
    padrao: true,
  },
  {
    id: 'nao_paciente_triage',
    nome: 'Contato não-paciente (IA)',
    descricao: 'Currículo, fornecedor, parceria ou propaganda que a IA repassou — com o arquivo que a pessoa mandou.',
    publico: 'admin',
    nicho: 'Contatos',
    padrao: false,
    central: 'aviso',
  },
];

export const DISPAROS_EQUIPE_IDS: readonly string[] = DISPAROS_EQUIPE.map((d) => d.id);

export function disparoEquipe(id: string): DisparoEquipe | undefined {
  return DISPAROS_EQUIPE.find((d) => d.id === id);
}

/** Profissional que atende (mesma regra do resumo do dentista): DENTIST, ou ADMIN com especialidade. */
export function ehProfissionalQueAtende(u: { roles?: string[] | null; specialties?: string[] | null }): boolean {
  const roles = u.roles || [];
  return roles.includes('DENTIST') || (roles.includes('ADMIN') && (u.specialties || []).length > 0);
}

/** ADM da clínica (papel ADMIN) — público dos avisos 'admin'. */
export function ehAdmDaClinica(u: { roles?: string[] | null }): boolean {
  return (u.roles || []).includes('ADMIN');
}

/** Disparos que fazem sentido pro papel da pessoa (o que aparece no cadastro dela). */
export function disparosEquipeDoPapel(u: { roles?: string[] | null; specialties?: string[] | null }): DisparoEquipe[] {
  const prof = ehProfissionalQueAtende(u);
  const adm = ehAdmDaClinica(u);
  return DISPAROS_EQUIPE.filter(
    (d) => d.publico === 'todos' || (d.publico === 'profissional' && prof) || (d.publico === 'admin' && adm),
  );
}

/** Pessoa como as regras de disparo enxergam (só as listas do cadastro). */
export interface PreferenciaDisparos {
  disparos_off?: string[] | null;
  disparos_on?: string[] | null;
}

/** A pessoa DESLIGOU este disparo no cadastro? (vale até sobre o número dela na Central) */
export function desligouDisparoEquipe(u: PreferenciaDisparos | null | undefined, id: string): boolean {
  return (u?.disparos_off || []).includes(id);
}

/**
 * A pessoa recebe este disparo? Desligou → não. Disparo `padrao` → sim. Senão, só se
 * foi adicionada: marcou no cadastro (disparos_on) ou o número está na Central (`naCentral`).
 */
export function recebeDisparoEquipe(
  u: PreferenciaDisparos | null | undefined,
  id: string,
  opts: { naCentral?: boolean } = {},
): boolean {
  if (desligouDisparoEquipe(u, id)) return false;
  const d = disparoEquipe(id);
  if (!d || d.padrao) return true;
  return (u?.disparos_on || []).includes(id) || !!opts.naCentral;
}

/** Saneia o que veio da tela (disparos_off / disparos_on): só ids conhecidos, sem repetição. */
export function normalizarDisparosIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && DISPAROS_EQUIPE_IDS.includes(x))));
}
/** @deprecated nome antigo — use normalizarDisparosIds. */
export const normalizarDisparosOff = normalizarDisparosIds;

/** O telefone (do cadastro) está numa lista de números de aviso? Casa pelo assinante (com/sem 9 e 55). */
export function telefoneNaListaDeAviso(phone: string | null | undefined, numeros: readonly string[]): boolean {
  const tel = toAlertPhone(phone);
  if (!tel) return false;
  const a = normalizeBrazilianPhone(tel);
  return numeros.some((n) => {
    const t = toAlertPhone(n);
    return !!t && normalizeBrazilianPhone(t) === a;
  });
}

// ─── Quem recebe um aviso dos ADMs ──────────────────────────────────────────

/** Membro da equipe como o envio enxerga (só o que a regra precisa). */
export interface MembroAvisoEquipe extends PreferenciaDisparos {
  id: string;
  name?: string | null;
  phone?: string | null;
  roles?: string[] | null;
}

export interface DestinatarioAviso {
  /** Número pronto pra envio (55 + DDD + número). */
  phone: string;
  /** Membro da equipe dono do número (null = número da Central que não é de ninguém do cadastro). */
  userId: string | null;
  nome: string | null;
}

/**
 * Destinatários de um aviso dos ADMs (`disparoId` = id de DISPAROS_EQUIPE):
 *   1. os números da Central (`numerosCentral`, já no formato de envio) — MENOS o de
 *      quem desligou esse aviso no cadastro (casa o número com a pessoa pelo
 *      assinante: com/sem 9, com/sem 55);
 *   2. + os ADMs com telefone válido que recebem pelo cadastro (marcaram o aviso, ou
 *      ele é `padrao`) — recebeDisparoEquipe.
 * Sem repetir o mesmo assinante. Ordem: Central primeiro, depois os ADMs.
 * Pura: quem chama lê a Central e os membros (ADMs + quem desligou o aviso).
 */
export function destinatariosAvisoAdm(
  disparoId: string,
  numerosCentral: readonly string[],
  membros: readonly MembroAvisoEquipe[],
): DestinatarioAviso[] {
  const assinante = (phone: string) => normalizeBrazilianPhone(phone);
  const telDe = (m: MembroAvisoEquipe) => toAlertPhone(m.phone);

  // Por assinante: quem desligou o aviso, o ADM que recebe pelo cadastro e, pra
  // identificar no histórico, qualquer membro com esse número.
  const desligou = new Set<string>();
  const admRecebe = new Map<string, MembroAvisoEquipe>();
  const membroDoNumero = new Map<string, MembroAvisoEquipe>();
  for (const m of membros) {
    const tel = telDe(m);
    if (!tel) continue;
    const a = assinante(tel);
    if (!membroDoNumero.has(a)) membroDoNumero.set(a, m);
    if (desligouDisparoEquipe(m, disparoId)) desligou.add(a);
    else if (ehAdmDaClinica(m) && recebeDisparoEquipe(m, disparoId) && !admRecebe.has(a)) admRecebe.set(a, m);
  }

  const out: DestinatarioAviso[] = [];
  const vistos = new Set<string>();
  const add = (phone: string, dono: MembroAvisoEquipe | null) => {
    const a = assinante(phone);
    if (vistos.has(a)) return;
    vistos.add(a);
    out.push({ phone, userId: dono?.id ?? null, nome: dono?.name ?? null });
  };

  for (const n of numerosCentral) {
    const tel = toAlertPhone(n);
    if (!tel) continue;
    const a = assinante(tel);
    // Quem desligou sai — a não ser que outro ADM com o mesmo número receba.
    if (desligou.has(a) && !admRecebe.has(a)) continue;
    add(tel, admRecebe.get(a) ?? membroDoNumero.get(a) ?? null);
  }
  for (const m of admRecebe.values()) add(telDe(m)!, m);
  return out;
}
