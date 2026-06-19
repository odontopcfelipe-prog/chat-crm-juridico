/**
 * Onda 17.32.115 — Setores e permissoes do SaaS.
 *
 * Fonte unica de verdade pra:
 *  - Os 5 setores do sistema (recepcao, dentista, crc, financeiro, admin)
 *  - Pacote de permissoes default de cada setor
 *  - Tipo Sector + Permission exportados pra TS
 *  - mapBackendRole(roles[]) — traduz roles antigas (DENTIST, OPERADOR,
 *    COMERCIAL, FINANCEIRO, ADMIN, ...) -> setor
 *
 * IMPORTANTE: UI NAO eh seguranca. Endpoints sensiveis tem que
 * exigir permissao no backend. Esconder um tile na home eh UX,
 * nao autorizacao real.
 */

export type Sector = 'recepcao' | 'dentista' | 'acd_asb' | 'crc' | 'financeiro' | 'admin';

export type Permission =
  | 'view_patients'      | 'edit_patients'
  | 'view_agenda'        | 'manage_agenda'
  | 'view_chat'
  | 'view_clinical'      | 'edit_clinical'
  | 'view_financial'     | 'manage_financial'
  | 'manage_proposals'
  | 'override_price'
  | 'view_reports'
  | 'view_marketing'
  | 'manage_users'
  | 'view_settings'      | 'manage_settings'
  | 'admin_saas';        // Cross-tenant (SUPER_ADMIN do SaaS)

// ─── Catalogo das 16 permissoes ─────────────────────────────────
export interface PermissionMeta {
  key: Permission;
  label: string;
  description: string;
  /** Grupo pra agrupar visualmente na UI de editar usuario */
  group: 'paciente' | 'agenda' | 'chat' | 'clinico' | 'financeiro' | 'marketing' | 'sistema';
}

export const PERMISSIONS: PermissionMeta[] = [
  // ─── Pacientes ──────────────────────────────────────────────
  { key: 'view_patients', label: 'Ver pacientes',
    description: 'Lista de pacientes + ficha basica', group: 'paciente' },
  { key: 'edit_patients', label: 'Cadastrar e editar pacientes',
    description: 'Criar ficha, alterar dados, adicionar tags', group: 'paciente' },

  // ─── Agenda ──────────────────────────────────────────────────
  { key: 'view_agenda', label: 'Ver agenda',
    description: 'Calendario, salas e cadeiras', group: 'agenda' },
  { key: 'manage_agenda', label: 'Gerenciar agenda',
    description: 'Marcar, remarcar e cancelar consultas', group: 'agenda' },

  // ─── Chat / WhatsApp ────────────────────────────────────────
  { key: 'view_chat', label: 'WhatsApp',
    description: 'Conversas, leads e atendimento', group: 'chat' },

  // ─── Clinico ─────────────────────────────────────────────────
  { key: 'view_clinical', label: 'Ver prontuario',
    description: 'Anamnese, evolucoes e procedimentos', group: 'clinico' },
  { key: 'edit_clinical', label: 'Editar prontuario',
    description: 'Preencher anamnese, anotacoes clinicas', group: 'clinico' },

  // ─── Financeiro ─────────────────────────────────────────────
  { key: 'view_financial', label: 'Ver financeiro',
    description: 'Dashboard, boletos e KPIs', group: 'financeiro' },
  { key: 'manage_financial', label: 'Gerenciar cobrancas',
    description: 'Emitir, cancelar e reverter cobrancas', group: 'financeiro' },
  { key: 'manage_proposals', label: 'Propostas e orcamentos',
    description: 'Criar e aprovar propostas + venda rapida', group: 'financeiro' },
  { key: 'override_price', label: 'Alterar preco na venda',
    description: 'Dar desconto (preco abaixo da tabela) na Venda Rapida', group: 'financeiro' },
  { key: 'view_reports', label: 'Ver relatorios',
    description: 'Dashboards e relatorios consolidados', group: 'financeiro' },

  // ─── Marketing / CRM ────────────────────────────────────────
  { key: 'view_marketing', label: 'CRC e Marketing',
    description: 'Funis, afiliados, retornos e follow-up', group: 'marketing' },

  // ─── Sistema ────────────────────────────────────────────────
  { key: 'manage_users', label: 'Gerenciar usuarios',
    description: 'Criar e editar usuarios do tenant', group: 'sistema' },
  { key: 'view_settings', label: 'Ver configuracoes',
    description: 'Visualizar abas de Configuracoes', group: 'sistema' },
  { key: 'manage_settings', label: 'Editar configuracoes',
    description: 'Mudar identidade da clinica, integracoes, etc', group: 'sistema' },
  { key: 'admin_saas', label: 'Admin SaaS (cross-tenant)',
    description: 'Gerencia todos os tenants — so SUPER_ADMIN', group: 'sistema' },
];

// ─── Configuracao da home dirigida por setor (skill home-por-setor) ─
export interface HomeAction {
  /** Emoji ou letra usada como icone (fallback se nao houver lucide) */
  icon: string;
  /** Nome do icone lucide-react (preferido — visual alinhado ao mockup) */
  lucide?: string;
  label: string;
  /** Descricao curta exibida abaixo do titulo (estilo mockup) */
  desc?: string;
  href: string;
  /** Tom da borda/glow do card */
  tone?: 'violet' | 'emerald' | 'amber' | 'sky' | 'rose';
}

/** Pilula de status / KPI exibida logo abaixo do hero */
export interface HomeHighlight {
  /** Numero ou texto curto exibido grande */
  value: string | number;
  /** Descricao da pilula */
  label: string;
  /** Tom visual */
  tone?: 'violet' | 'emerald' | 'amber' | 'sky' | 'rose';
}

/** Bloco em destaque (chips/filas/KPIs) — proprio de cada setor */
export interface HomeHighlightBlock {
  /** Titulo do bloco (ex: "Agenda de hoje", "Filas do WhatsApp") */
  title: string;
  /** Icone do titulo (emoji) */
  icon: string;
  /** Chips de KPI */
  chips: HomeHighlight[];
  /** Link "ver tudo" no canto direito (opcional) */
  cta?: { label: string; href: string };
}

export interface HomeConfig {
  /** Como o setor se chama na saudacao (ex: "Recepcionista") */
  persona: string;
  /** Frase curta de contexto exibida abaixo do "Bom dia, X" */
  subtitle: string;
  /** Bloco em destaque com chips/KPIs do setor */
  highlight: HomeHighlightBlock;
  /** Acoes em destaque (3-6 cards no topo) */
  actions: HomeAction[];
  /** Afazeres tipicos do setor (lista de strings) */
  todos: string[];
}

// ─── Os 5 setores ───────────────────────────────────────────────
export interface SectorMeta {
  id: Sector;
  name: string;
  description: string;
  /** Emoji pra exibir na UI (lucide-react opcional na proxima onda) */
  icon: string;
  /** Roles do User.roles que mapeam pra esse setor */
  backendRoles: string[];
  /** Permissoes default desse setor — pre-marcadas no editar usuario */
  defaultPermissions: Permission[];
  /** Configuracao da home dirigida por setor */
  home: HomeConfig;
}

export const SECTORS: SectorMeta[] = [
  {
    id: 'recepcao',
    name: 'Recepcao',
    description: 'Atende, agenda, faz venda balcao e cuida do contato inicial',
    icon: '🛎️',
    backendRoles: ['OPERADOR'],
    defaultPermissions: [
      'view_patients', 'edit_patients',
      'view_agenda',   'manage_agenda',
      'view_chat',
      // Onda 17.52 — recepção também preenche a anamnese no cadastro do paciente
      // (decisão do usuário). Sem isso, travar o prontuário (Etapa 4/5) quebraria
      // o onboarding. Dá acesso clínico à recepção; CRC/financeiro continuam sem.
      'view_clinical', 'edit_clinical',
      // Onda 17.32.115 (revisao 1): recepcao tambem fecha venda
      // balcao (Venda Rapida) e gera proposta inicial.
      'manage_proposals',
    ],
    home: {
      persona: 'Recepcionista',
      subtitle: 'Bom trabalho! Organize o dia e mantenha a agenda cheia.',
      highlight: {
        title: 'Agenda de hoje',
        icon: '📅',
        chips: [
          { value: 8, label: 'consultas',       tone: 'violet'  },
          { value: 3, label: 'a confirmar',     tone: 'amber'   },
          { value: 2, label: 'encaixes livres', tone: 'emerald' },
        ],
        cta: { label: 'Abrir agenda do dia', href: '/atendimento/agenda' },
      },
      actions: [
        { lucide: 'Calendar',      icon: '📅', label: 'Agenda',       desc: 'Veja e marque os horários do dia.',      href: '/atendimento/agenda',        tone: 'violet'  },
        { lucide: 'Zap',           icon: '⚡', label: 'Venda rápida', desc: 'Registre uma venda avulsa em segundos.', href: '/atendimento/venda-rapida',  tone: 'emerald' },
        { lucide: 'Users',         icon: '👥', label: 'Pacientes',    desc: 'Busque, cadastre e abra fichas.',        href: '/atendimento/pacientes',     tone: 'sky'     },
        { lucide: 'MessageSquare', icon: '💬', label: 'WhatsApp',     desc: 'Converse e confirme com os pacientes.',  href: '/atendimento',               tone: 'amber'   },
        { lucide: 'RotateCcw',     icon: '🔄', label: 'Retornos',     desc: 'Veja quem precisa voltar à clínica.',    href: '/atendimento/return-alerts', tone: 'rose'    },
        { lucide: 'FileText',      icon: '📄', label: 'Orçamentos',   desc: 'Monte e envie orçamentos ao paciente.',  href: '/atendimento/orcamentos',    tone: 'violet'  },
      ],
      todos: [
        'Confirmar agendamentos de amanha',
        'Atender pacientes na recepcao',
        'Receber pagamentos no balcao',
        'Atualizar dados de cadastro',
      ],
    },
  },
  {
    id: 'dentista',
    name: 'Dentista',
    description: 'Atende, preenche prontuario e cria propostas',
    icon: '🦷',
    backendRoles: ['DENTIST', 'DENTISTA'],
    defaultPermissions: [
      'view_patients', 'edit_patients',
      'view_agenda',
      // Onda 17.52 — Dentista NÃO usa WhatsApp (decisão do usuário): sem
      // view_chat e sem balão de WhatsApp. Recepção/CRC cuidam do chat.
      'view_clinical', 'edit_clinical',
      'manage_proposals',
      // Dentista define/desconta preco nas propostas — mantem o que ja fazia.
      'override_price',
    ],
    home: {
      persona: 'Dentista',
      subtitle: 'Atenda os pacientes do dia e mantenha o prontuario em dia.',
      highlight: {
        title: 'Sua agenda clinica',
        icon: '🦷',
        chips: [
          { value: 4,        label: 'pacientes hoje', tone: 'violet'  },
          { value: '15min',  label: 'proximo',        tone: 'emerald' },
          { value: 2,        label: 'anamneses pendentes', tone: 'amber' },
        ],
        cta: { label: 'Ver minha agenda', href: '/atendimento/agenda' },
      },
      actions: [
        { lucide: 'Calendar', icon: '📅', label: 'Minha agenda',        desc: 'Seus atendimentos de hoje.',      href: '/atendimento/agenda',     tone: 'violet'  },
        { lucide: 'Users',    icon: '👥', label: 'Pacientes',           desc: 'Prontuário e histórico clínico.', href: '/atendimento/pacientes',  tone: 'sky'     },
        { lucide: 'FileText', icon: '📄', label: 'Plano de tratamento', desc: 'Monte e apresente o plano.',      href: '/atendimento/orcamentos', tone: 'emerald' },
      ],
      todos: [
        'Pacientes pra atender hoje',
        'Anamneses pendentes',
        'Propostas pra finalizar',
        'Retornos da semana',
      ],
    },
  },
  {
    // Onda 17.32.122 — ACD/ASB (Auxiliar Consultorio Dentario /
    // Auxiliar em Saude Bucal). Trabalha no consultorio assistindo
    // o dentista: prepara sala, instrumental, organiza materiais,
    // acompanha prontuario, conversa com paciente.
    id: 'acd_asb',
    name: 'ACD / ASB',
    description: 'Auxilia o dentista — prepara sala, instrumental e acompanha o atendimento',
    icon: '🧤',
    backendRoles: ['ACD', 'ASB', 'ACD_ASB', 'AUXILIAR', 'ASSISTANT'],
    defaultPermissions: [
      'view_patients',     // ve quem esta sendo atendido
      'view_agenda',       // ve agenda do dia
      // Onda 17.52 — ACD/ASB sem WhatsApp (decisão do usuário): sem view_chat
      // e sem balão. Recepção/CRC cuidam do chat.
      'view_clinical',     // acompanha prontuario do paciente
      'edit_clinical',     // ASB pode preencher evolucao supervisionada
    ],
    home: {
      persona: 'Auxiliar de Consultorio',
      subtitle: 'Prepare o consultorio, organize materiais e ajude o dentista a entregar o melhor atendimento.',
      highlight: {
        title: 'Consultorio agora',
        icon: '🧤',
        chips: [
          { value: 4,        label: 'consultas hoje',           tone: 'violet'  },
          { value: '12min',  label: 'proxima consulta',         tone: 'emerald' },
          { value: 2,        label: 'salas pra esterilizar',    tone: 'amber'   },
        ],
        cta: { label: 'Ver agenda do dia', href: '/atendimento/agenda' },
      },
      actions: [
        { lucide: 'Calendar', icon: '📅', label: 'Agenda',    desc: 'Acompanhe os atendimentos do dia.', href: '/atendimento/agenda',    tone: 'violet' },
        { lucide: 'Users',    icon: '👥', label: 'Pacientes', desc: 'Consulte fichas e dados.',          href: '/atendimento/pacientes', tone: 'sky'    },
      ],
      todos: [
        'Preparar sala pra proxima consulta',
        'Esterilizar instrumental do turno',
        'Conferir cadeiras e materiais',
        'Avisar dentista sobre encaixes',
      ],
    },
  },
  {
    id: 'crc',
    name: 'CRC (Atendimento)',
    description: 'Central de relacionamento — captacao, follow-up e marketing',
    icon: '💬',
    backendRoles: ['COMERCIAL', 'ASSISTANT'],
    defaultPermissions: [
      'view_patients',
      // Onda 17.32.115 (revisao 1): CRC ve agenda pra sugerir
      // horarios e conferir disponibilidade dos dentistas.
      'view_agenda',
      'view_chat',
      'view_marketing',
      'manage_proposals',
      // CRC negocia desconto na pre-venda — mantem o que ja fazia.
      'override_price',
    ],
    home: {
      persona: 'CRC',
      subtitle: 'Central de relacionamento — capta, nutre e fecha leads.',
      highlight: {
        title: 'Filas do WhatsApp',
        icon: '💬',
        chips: [
          { value: 12, label: 'novas conversas',      tone: 'violet'  },
          { value: 5,  label: 'sem resposta +2h',     tone: 'amber'   },
          { value: 3,  label: 'follow-ups vencidos',  tone: 'rose'    },
        ],
        cta: { label: 'Abrir WhatsApp', href: '/atendimento' },
      },
      actions: [
        { lucide: 'LineChart',     icon: '🎯', label: 'CRM',         desc: 'Recupere pacientes e oportunidades.', href: '/atendimento/crm',                    tone: 'violet'  },
        { lucide: 'Workflow',      icon: '🔁', label: 'Follow-up',   desc: 'Acompanhe os contatos automáticos.',  href: '/atendimento/followup',               tone: 'amber'   },
        { lucide: 'RotateCcw',     icon: '🔄', label: 'Retornos',    desc: 'Pacientes que precisam voltar.',      href: '/atendimento/return-alerts',          tone: 'rose'    },
        { lucide: 'CheckCheck',    icon: '✅', label: 'Fechamentos', desc: 'Negocie e feche tratamentos.',        href: '/atendimento/fechamentos',            tone: 'emerald' },
        { lucide: 'Layers',        icon: '📑', label: 'Propostas',      desc: 'Acompanhe as propostas enviadas.',      href: '/atendimento/orcamentos?status=SENT', tone: 'sky'     },
        { lucide: 'MessageSquare', icon: '💬', label: 'WhatsApp',       desc: 'Converse com os pacientes.',            href: '/atendimento',                        tone: 'amber'   },
        { lucide: 'Cake',          icon: '🎂', label: 'Aniversariantes', desc: 'Parabenize quem faz aniversário hoje.', href: '/atendimento/pacientes',              tone: 'rose'    },
      ],
      todos: [
        'Mensagens sem resposta',
        'Follow-ups vencidos',
        'Leads novos no funil',
        'Orcamentos pendentes de retorno',
      ],
    },
  },
  {
    id: 'financeiro',
    name: 'Financeiro',
    description: 'Cobrancas, conciliacao, relatorios',
    icon: '💰',
    backendRoles: ['FINANCEIRO'],
    defaultPermissions: [
      'view_patients',
      'view_agenda',
      'view_financial', 'manage_financial',
      'view_reports',
    ],
    home: {
      persona: 'Financeiro',
      subtitle: 'Cobrancas, conciliacao e visao geral do caixa.',
      highlight: {
        title: 'Caixa do dia',
        icon: '💰',
        chips: [
          { value: 'R$ 2.480', label: 'recebido hoje',   tone: 'emerald' },
          { value: 'R$ 850',   label: 'vencendo hoje',   tone: 'amber'   },
          { value: 4,          label: 'inadimplentes',   tone: 'rose'    },
        ],
        cta: { label: 'Abrir financeiro', href: '/atendimento/financeiro' },
      },
      actions: [
        { lucide: 'LineChart', icon: '📊', label: 'Visão geral', desc: 'Caixa, receitas e despesas.', href: '/atendimento/financeiro/dashboard',   tone: 'emerald' },
        { lucide: 'Receipt',   icon: '🧾', label: 'Cobranças',   desc: 'Régua de cobrança e atrasos.', href: '/atendimento/financeiro',             tone: 'violet'  },
        { lucide: 'FileText',  icon: '📄', label: 'Orçamentos',  desc: 'Orçamentos e conversão.',     href: '/atendimento/orcamentos',             tone: 'sky'     },
        { lucide: 'Layers',    icon: '📑', label: 'Propostas',   desc: 'Propostas e contratos.',      href: '/atendimento/orcamentos?status=SENT', tone: 'amber'   },
        { lucide: 'PieChart',  icon: '📈', label: 'Indicadores', desc: 'Números do financeiro.',      href: '/atendimento/relatorios',             tone: 'rose'    },
      ],
      todos: [
        'Boletos que vencem hoje',
        'Cobrar parcelas atrasadas',
        'Conciliar entradas Asaas',
        'Fechar dia / fechamento mensal',
      ],
    },
  },
  {
    id: 'admin',
    name: 'Administrador',
    description: 'Acesso completo ao tenant',
    icon: '👑',
    backendRoles: ['ADMIN', 'SUPER_ADMIN'],
    defaultPermissions: PERMISSIONS.map(p => p.key)
      .filter(k => k !== 'admin_saas'), // SUPER_ADMIN ganha admin_saas separado
    home: {
      persona: 'Administrador',
      subtitle: 'Visao completa do tenant. Pendencias, equipe e KPIs.',
      highlight: {
        title: 'Pendencias e indicadores',
        icon: '👑',
        chips: [
          { value: 6,    label: 'pendencias da equipe', tone: 'amber'   },
          { value: '92%', label: 'comparecimento',      tone: 'emerald' },
          { value: 2,    label: 'alertas no painel',    tone: 'rose'    },
        ],
        cta: { label: 'Ver detalhes', href: '/atendimento/relatorios' },
      },
      actions: [
        { lucide: 'Calendar',  icon: '📅', label: 'Agenda',        desc: 'Toda a agenda da clínica.',     href: '/atendimento/agenda',              tone: 'violet'  },
        { lucide: 'Users',     icon: '👥', label: 'Pacientes',     desc: 'Base completa de pacientes.',   href: '/atendimento/pacientes',           tone: 'sky'     },
        { lucide: 'LineChart', icon: '🎯', label: 'CRC',           desc: 'Recuperação e relacionamento.', href: '/atendimento/crm',                 tone: 'rose'    },
        { lucide: 'Wallet',    icon: '💰', label: 'Financeiro',    desc: 'Caixa, cobranças e contratos.', href: '/atendimento/financeiro',          tone: 'emerald' },
        { lucide: 'UserCog',   icon: '👥', label: 'Equipe',        desc: 'Profissionais e permissões.',   href: '/atendimento/settings/users',      tone: 'sky'     },
        { lucide: 'Megaphone', icon: '📢', label: 'Marketing',     desc: 'Campanhas e captação.',         href: '/atendimento/marketing/analytics', tone: 'amber'   },
        { lucide: 'FileText',  icon: '📄', label: 'Relatórios',    desc: 'Indicadores e metas.',          href: '/atendimento/relatorios',          tone: 'violet'  },
        { lucide: 'Settings',  icon: '⚙️', label: 'Configurações', desc: 'Ajustes do sistema.',           href: '/atendimento/settings',            tone: 'amber'   },
      ],
      todos: [
        'Aprovar pendencias da equipe',
        'Revisar agenda e cobrancas do dia',
        'Conferir indicadores',
        'Resolver alertas no painel',
      ],
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Traduz o array de roles do User pro setor. Pega o primeiro que
 * der match. Default = 'recepcao' (mais restrito que admin pra
 * nao expor demais por engano).
 *
 * Ordem de prioridade:
 *   admin > dentista > acd_asb > financeiro > crc > recepcao.
 *
 * Onda 17.32.122 — ACD/ASB ficou ACIMA de financeiro e crc na
 * prioridade porque eh funcao clinica especifica (auxiliar
 * direto do dentista), enquanto ASSISTANT pode ser tanto CRC quanto
 * auxiliar clinico — se tem so ASSISTANT, cai em CRC pra nao mudar
 * comportamento atual de quem ja estava em outras unidades.
 */
export function mapBackendRole(roles: string[] | null | undefined): Sector {
  if (!roles || roles.length === 0) return 'recepcao';
  const set = new Set(roles.map(r => r.toUpperCase()));

  if (set.has('SUPER_ADMIN') || set.has('ADMIN'))                  return 'admin';
  if (set.has('DENTIST')     || set.has('DENTISTA'))               return 'dentista';
  // ACD/ASB: roles especificas de auxiliar clinico
  if (set.has('ACD') || set.has('ASB') || set.has('ACD_ASB') || set.has('AUXILIAR')) return 'acd_asb';
  if (set.has('FINANCEIRO'))                                       return 'financeiro';
  if (set.has('COMERCIAL')   || set.has('ASSISTANT'))              return 'crc';
  if (set.has('OPERADOR'))                                         return 'recepcao';

  return 'recepcao';
}

/** Acha o SectorMeta pelo id. */
export function getSector(id: Sector | string | null | undefined): SectorMeta {
  const found = SECTORS.find(s => s.id === id);
  return found ?? SECTORS[0];
}

/** Une defaults do setor + overrides individuais do user. */
export function resolvePermissions(
  sectorId: Sector,
  extraGrants: Permission[] = [],
  extraRevokes: Permission[] = [],
): Set<Permission> {
  const sector = getSector(sectorId);
  const base = new Set<Permission>(sector.defaultPermissions);
  extraGrants.forEach(p => base.add(p));
  extraRevokes.forEach(p => base.delete(p));
  return base;
}

/** Pra UI: agrupa as permissoes por categoria. */
export function permissionsByGroup() {
  const groups: Record<string, PermissionMeta[]> = {};
  for (const p of PERMISSIONS) {
    (groups[p.group] ??= []).push(p);
  }
  return groups;
}

// ─── Balões x permissões (Onda 17.52) ───────────────────────────
//
// A home (balões) reflete as PERMISSÕES efetivas do usuário, não só os
// defaults do setor: conceder uma permissão extra ADICIONA o balão dela;
// revogar uma permissão REMOVE o balão. Assim a prévia no editor de usuário
// e a home real batem com o que foi marcado.

/** Qual permissão "abre" cada balão (pela rota). Usado pra remover ao revogar. */
const HREF_TO_PERMISSION: Record<string, Permission> = {
  '/atendimento':                          'view_chat',        // WhatsApp
  '/atendimento/agenda':                   'view_agenda',
  '/atendimento/pacientes':                'view_patients',
  '/atendimento/venda-rapida':             'manage_proposals',
  '/atendimento/orcamentos':               'manage_proposals',
  '/atendimento/orcamentos?status=SENT':   'manage_proposals',
  '/atendimento/crm':                      'view_marketing',
  '/atendimento/followup':                 'view_marketing',
  '/atendimento/fechamentos':              'manage_proposals',
  '/atendimento/return-alerts':            'view_marketing',
  '/atendimento/financeiro':               'manage_financial',
  '/atendimento/financeiro/dashboard':     'view_financial',
  '/atendimento/relatorios':               'view_reports',
  '/atendimento/marketing/analytics':      'view_marketing',
  '/atendimento/settings':                 'view_settings',
  '/atendimento/settings/users':           'manage_users',
};

/** Balão representativo pra mostrar quando a permissão é concedida EXTRA. */
const PERMISSION_TO_BALAO: Partial<Record<Permission, HomeAction>> = {
  view_chat:        { lucide: 'MessageSquare', icon: '💬', label: 'WhatsApp',    desc: 'Conversas e atendimento.',    href: '/atendimento',                      tone: 'amber'   },
  view_agenda:      { lucide: 'Calendar',      icon: '📅', label: 'Agenda',      desc: 'Agenda da clínica.',          href: '/atendimento/agenda',               tone: 'violet'  },
  view_patients:    { lucide: 'Users',         icon: '👥', label: 'Pacientes',   desc: 'Base de pacientes.',          href: '/atendimento/pacientes',            tone: 'sky'     },
  manage_proposals: { lucide: 'FileText',      icon: '📄', label: 'Orçamentos',  desc: 'Orçamentos e propostas.',     href: '/atendimento/orcamentos',           tone: 'emerald' },
  view_marketing:   { lucide: 'LineChart',     icon: '🎯', label: 'CRM',         desc: 'Funil e relacionamento.',     href: '/atendimento/crm',                  tone: 'violet'  },
  view_financial:   { lucide: 'LineChart',     icon: '📊', label: 'Visão geral', desc: 'Caixa e indicadores.',        href: '/atendimento/financeiro/dashboard', tone: 'emerald' },
  manage_financial: { lucide: 'Receipt',       icon: '🧾', label: 'Cobranças',   desc: 'Boletos e recebimentos.',     href: '/atendimento/financeiro',           tone: 'violet'  },
  view_reports:     { lucide: 'PieChart',      icon: '📈', label: 'Relatórios',  desc: 'Indicadores e metas.',        href: '/atendimento/relatorios',           tone: 'rose'    },
  manage_users:     { lucide: 'UserCog',       icon: '👥', label: 'Equipe',      desc: 'Profissionais e permissões.', href: '/atendimento/settings/users',       tone: 'sky'     },
  view_settings:    { lucide: 'Settings',      icon: '⚙️', label: 'Configurações', desc: 'Ajustes do sistema.',       href: '/atendimento/settings',             tone: 'amber'   },
};

/**
 * Balões EFETIVOS de um usuário: parte dos balões curados do setor, remove os
 * cuja permissão foi REVOGADA e adiciona os balões das permissões CONCEDIDAS
 * extra (que ainda não estão na lista). Mantém a curadoria do setor + reflete
 * os ajustes individuais. Usado na home e na prévia do editor de usuário.
 */
export function resolveHomeActions(
  sectorId: Sector,
  extraGrants: Permission[] = [],
  extraRevokes: Permission[] = [],
): HomeAction[] {
  const sector = getSector(sectorId);
  const revokes = new Set(extraRevokes);

  // 1) Curado do setor, menos os balões cuja permissão foi revogada.
  const base = sector.home.actions.filter((a) => {
    const perm = HREF_TO_PERMISSION[a.href];
    return !(perm && revokes.has(perm));
  });

  // 2) Adiciona o balão de cada permissão concedida EXTRA (sem duplicar rota).
  const hrefs = new Set(base.map((a) => a.href));
  const extras: HomeAction[] = [];
  for (const perm of extraGrants) {
    const balao = PERMISSION_TO_BALAO[perm];
    if (balao && !hrefs.has(balao.href)) {
      extras.push(balao);
      hrefs.add(balao.href);
    }
  }

  return [...base, ...extras];
}
