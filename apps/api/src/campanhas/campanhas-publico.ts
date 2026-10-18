// Público da campanha manual: pacientes por filtro (os mesmos critérios da tela de
// Pacientes) + quem fica de fora e por quê. Puro — testável sem banco.
import type { Prisma } from '@crm/shared';
import type { CampanhaFiltros } from '@crm/shared';

/** Mesma regra da tela de Pacientes (patients.service: INACTIVE_AFTER_MONTHS = 12). */
const INATIVO_APOS_MESES = 12;

export function corteInativo(agora: Date): Date {
  const d = new Date(agora);
  d.setMonth(d.getMonth() - INATIVO_APOS_MESES);
  return d;
}

/** WHERE dos pacientes da campanha. Arquivado NUNCA entra; sempre escopado na clínica. */
export function wherePublico(tenantId: string, f: CampanhaFiltros, agora: Date): Prisma.PatientWhereInput {
  const and: Prisma.PatientWhereInput[] = [{ tenant_id: tenantId }, { status: { not: 'ARCHIVED' } }];
  if (f.tagIds?.length) and.push({ tags: { some: { tag_id: { in: f.tagIds } } } });
  if (f.atividade) {
    const corte = corteInativo(agora);
    and.push(
      f.atividade === 'ACTIVE'
        ? { OR: [{ last_visit_at: { gte: corte } }, { last_visit_at: null, created_at: { gte: corte } }] }
        : { OR: [{ last_visit_at: { lt: corte } }, { last_visit_at: null, created_at: { lt: corte } }] },
    );
  }
  if (f.semVisitaMeses) {
    const corte = new Date(agora);
    corte.setMonth(corte.getMonth() - f.semVisitaMeses);
    and.push({ OR: [{ last_visit_at: { lt: corte } }, { last_visit_at: null }] });
  }
  if (f.dentistaId) and.push({ primary_dentist_id: f.dentistaId });
  if (f.comTratamentoAtivo) and.push({ treatment_plans: { some: { status: 'ACTIVE' } } });
  if (f.aniversariantesDoMes) and.push({ birth_date: { not: null } }); // o mês é filtrado em Node
  return { AND: and };
}

export type PacientePublico = {
  id: string;
  name: string | null;
  phone: string | null;
  birth_date: Date | null;
  lead: { contact_opt_out_at: Date | null; whatsapp_invalid_at: Date | null; non_patient_category: string | null } | null;
};

export type MotivoFora = 'sem_telefone' | 'nao_recebe' | 'numero_invalido';

export const MOTIVO_FORA_LABEL: Record<MotivoFora, string> = {
  sem_telefone: 'sem telefone',
  nao_recebe: 'pediu pra não receber',
  numero_invalido: 'número sem WhatsApp',
};

/** Por que este paciente NÃO recebe (null = recebe). */
export function motivoFora(p: PacientePublico): MotivoFora | null {
  if ((p.phone || '').replace(/\D/g, '').length < 10) return 'sem_telefone';
  if (p.lead?.contact_opt_out_at || p.lead?.non_patient_category) return 'nao_recebe';
  if (p.lead?.whatsapp_invalid_at) return 'numero_invalido';
  return null;
}

/** Aniversariante do mês (componentes UTC da data de nascimento × mês de Maceió). */
export function aniversarianteDoMes(birth: Date | null, agora: Date): boolean {
  if (!birth) return false;
  const local = new Date(agora.getTime() - 3 * 3600e3);
  return new Date(birth).getUTCMonth() === local.getUTCMonth();
}
