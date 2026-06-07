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

export type Sector = 'recepcao' | 'dentista' | 'crc' | 'financeiro' | 'admin';

export type Permission =
  | 'view_patients'      | 'edit_patients'
  | 'view_agenda'        | 'manage_agenda'
  | 'view_chat'
  | 'view_clinical'      | 'edit_clinical'
  | 'view_financial'     | 'manage_financial'
  | 'manage_proposals'
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
  { key: 'view_reports', label: 'Ver relatorios',
    description: 'Dashboards e relatorios consolidados', group: 'financeiro' },

  // ─── Marketing / CRM ────────────────────────────────────────
  { key: 'view_marketing', label: 'CRM e Marketing',
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
}

export const SECTORS: SectorMeta[] = [
  {
    id: 'recepcao',
    name: 'Recepcao',
    description: 'Atende, agenda e cuida do contato inicial com o paciente',
    icon: '🛎️',
    backendRoles: ['OPERADOR'],
    defaultPermissions: [
      'view_patients', 'edit_patients',
      'view_agenda',   'manage_agenda',
      'view_chat',
    ],
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
      'view_chat',
      'view_clinical', 'edit_clinical',
      'manage_proposals',
    ],
  },
  {
    id: 'crc',
    name: 'CRC (Atendimento)',
    description: 'Central de relacionamento — captacao, follow-up e marketing',
    icon: '💬',
    backendRoles: ['COMERCIAL', 'ASSISTANT'],
    defaultPermissions: [
      'view_patients',
      'view_chat',
      'view_marketing',
      'manage_proposals',
    ],
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
  },
  {
    id: 'admin',
    name: 'Administrador',
    description: 'Acesso completo ao tenant',
    icon: '👑',
    backendRoles: ['ADMIN', 'SUPER_ADMIN'],
    defaultPermissions: PERMISSIONS.map(p => p.key)
      .filter(k => k !== 'admin_saas'), // SUPER_ADMIN ganha admin_saas separado
  },
];

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Traduz o array de roles do User pro setor. Pega o primeiro que
 * der match. Default = 'recepcao' (mais restrito que admin pra
 * nao expor demais por engano).
 *
 * Ordem de prioridade: admin > dentista > financeiro > crc > recepcao.
 */
export function mapBackendRole(roles: string[] | null | undefined): Sector {
  if (!roles || roles.length === 0) return 'recepcao';
  const set = new Set(roles.map(r => r.toUpperCase()));

  if (set.has('SUPER_ADMIN') || set.has('ADMIN'))                  return 'admin';
  if (set.has('DENTIST')     || set.has('DENTISTA'))               return 'dentista';
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
