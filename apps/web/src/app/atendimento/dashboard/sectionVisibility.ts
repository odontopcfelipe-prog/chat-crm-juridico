import type { RoleInfo } from '@/lib/useRole';

export type SectionId = 'geral' | 'comercial' | 'financeiro' | 'estagiarios';

export type Scope = 'comercial' | 'financeiro' | 'estagiarios';

/** Quais seções cada papel pode ver. */
export function visibleSections(role: RoleInfo): SectionId[] {
  if (role.isAdmin) {
    return ['geral', 'comercial', 'financeiro', 'estagiarios'];
  }
  if (role.isAdvogado) {
    return ['comercial', 'financeiro', 'estagiarios'];
  }
  if (role.isComercial || role.isOperador) {
    return ['comercial'];
  }
  if (role.isFinanceiro) {
    return ['financeiro'];
  }
  if (role.isEstagiario) {
    return ['estagiarios'];
  }
  return [];
}

/**
 * Escopo a ser aplicado nas chamadas de API para cada seção.
 */
export function scopeForSection(id: SectionId, _role: RoleInfo): Scope | undefined {
  if (id === 'geral') return undefined;
  if (id === 'comercial') return 'comercial';
  if (id === 'financeiro') return 'financeiro';
  if (id === 'estagiarios') return 'estagiarios';
  return undefined;
}

export const SECTION_META: Record<SectionId, { title: string; subtitle: string }> = {
  geral: {
    title: 'Visão Geral',
    subtitle: 'KPIs consolidados',
  },
  comercial: {
    title: 'Comercial',
    subtitle: 'Leads, conversão e atendimento',
  },
  financeiro: {
    title: 'Financeiro',
    subtitle: 'Receita, recebimentos e aging',
  },
  estagiarios: {
    title: 'Equipe',
    subtitle: 'Tarefas e produtividade',
  },
};
