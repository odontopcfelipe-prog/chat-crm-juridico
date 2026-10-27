/**
 * F3 do laboratório — o que uma conta de LABORATÓRIO recebe ao nascer.
 *
 * O laboratório de prótese é o mesmo sistema da clínica com outros nomes, e nada
 * de clínica é plantado nele: sem anamnese, sem procedimentos odontológicos, sem
 * as categorias financeiras da clínica e sem funil de captação de paciente.
 *
 * O que tem aqui:
 *  - grupos de prótese (Specialty) e serviços do catálogo (Procedure) com preço 0,
 *    na venda rápida e sem comissão — o laboratório põe o preço dele antes de vender;
 *  - categorias financeiras de laboratório (impedem o seed lazy da clínica);
 *  - funil 'Captação de dentistas' (slugs sem 'agend', 'marcad' e 'avalia');
 *  - chaves desligadas da conta: IA, fora do expediente, recall, alertas de tarefa,
 *    lembretes, confirmação/remarcação, confirmação de pagamento, aniversário,
 *    régua de cobrança e missões. TenantSetting com tenant_id da conta; GlobalSetting
 *    SEMPRE com o sufixo _<tenantId> (nada global).
 *
 * seedLabTenantDefaults roda dentro da transação da criação; ensureLabDefaults só
 * grava a chave que falta (nunca sobrescreve o que a conta mudou) e também roda
 * num cron diário. tenant-defaults.ts (a clínica) fica intacto.
 */
import type { PrismaClient } from '@prisma/client';
import { AI_CHIP_PURPOSES, aiEnabledKey, aiProfileKey } from './ai-profile';
import { chaveConfigDaConta } from './conta-legada';

// ─── Catálogo de prótese ─────────────────────────────────────────
export const GRUPOS_DE_PROTESE = [
  { name: 'Prótese fixa',           description: 'Coroas, pontes, núcleos e provisórios' },
  { name: 'Cerâmica estética',      description: 'Facetas, lentes e peças em cerâmica pura' },
  { name: 'Prótese removível',      description: 'Prótese total, parcial removível e consertos' },
  { name: 'Prótese sobre implante', description: 'Coroas, protocolos e overdentures sobre implante' },
  { name: 'Placas e aparelhos',     description: 'Placas oclusais, de clareamento e aparelhos removíveis' },
  { name: 'Modelos e planejamento', description: 'Modelos, enceramento e guias' },
] as const;

export interface ServicoDeProtese {
  name: string;
  /** bate com GRUPOS_DE_PROTESE[i].name */
  grupo: string;
}

export const SERVICOS_DE_PROTESE: ServicoDeProtese[] = [
  { name: 'Coroa metalocerâmica',               grupo: 'Prótese fixa' },
  { name: 'Coroa em zircônia',                  grupo: 'Prótese fixa' },
  { name: 'Coroa em dissilicato de lítio',      grupo: 'Prótese fixa' },
  { name: 'Coroa provisória',                   grupo: 'Prótese fixa' },
  { name: 'Núcleo metálico fundido',            grupo: 'Prótese fixa' },
  { name: 'Ponte fixa (por elemento)',          grupo: 'Prótese fixa' },
  { name: 'Faceta em cerâmica',                 grupo: 'Cerâmica estética' },
  { name: 'Lente de contato em cerâmica',       grupo: 'Cerâmica estética' },
  { name: 'Inlay / onlay em cerâmica',          grupo: 'Cerâmica estética' },
  { name: 'Prótese total acrílica',             grupo: 'Prótese removível' },
  { name: 'Prótese parcial removível (PPR)',    grupo: 'Prótese removível' },
  { name: 'Reembasamento',                      grupo: 'Prótese removível' },
  { name: 'Conserto de prótese',                grupo: 'Prótese removível' },
  { name: 'Coroa parafusada sobre implante',    grupo: 'Prótese sobre implante' },
  { name: 'Protocolo sobre implante',           grupo: 'Prótese sobre implante' },
  { name: 'Overdenture',                        grupo: 'Prótese sobre implante' },
  { name: 'Placa miorrelaxante',                grupo: 'Placas e aparelhos' },
  { name: 'Placa de clareamento',               grupo: 'Placas e aparelhos' },
  { name: 'Aparelho ortodôntico removível',     grupo: 'Placas e aparelhos' },
  { name: 'Modelo de estudo',                   grupo: 'Modelos e planejamento' },
  { name: 'Enceramento diagnóstico',            grupo: 'Modelos e planejamento' },
  { name: 'Guia cirúrgico',                     grupo: 'Modelos e planejamento' },
];

// ─── Categorias financeiras ──────────────────────────────────────
// DIARIA fica por causa do lançador de diária do Financeiro.
export const CATEGORIAS_FINANCEIRAS_DO_LABORATORIO = [
  { type: 'RECEITA', name: 'Serviços de prótese',        icon: 'flask' },
  { type: 'RECEITA', name: 'Consertos e ajustes',        icon: 'wrench' },
  { type: 'RECEITA', name: 'Outros',                     icon: 'ellipsis' },
  { type: 'DESPESA', name: 'Aluguel',                    icon: 'home' },
  { type: 'DESPESA', name: 'Materiais e insumos',        icon: 'package' },
  { type: 'DESPESA', name: 'Serviços terceirizados',     icon: 'factory' },
  { type: 'DESPESA', name: 'Folha de Pagamento',         icon: 'users' },
  { type: 'DESPESA', name: 'Contas (agua/luz/internet)', icon: 'zap' },
  { type: 'DESPESA', name: 'Equipamentos e manutenção',  icon: 'wrench' },
  { type: 'DESPESA', name: 'Entrega e transporte',       icon: 'truck' },
  { type: 'DESPESA', name: 'DIARIA',                     icon: 'calendar-clock' },
  { type: 'DESPESA', name: 'Outros',                     icon: 'ellipsis' },
] as const;

// ─── Funil de captação ───────────────────────────────────────────
export const FUNIL_CAPTACAO_DE_DENTISTAS = {
  name: 'Captação de dentistas',
  slug: 'captacao-dentistas',
  description: 'Dentistas e consultórios que podem passar a mandar trabalhos para o laboratório.',
  color: '#0ea5e9',
  stages: [
    { name: 'Novo contato',             slug: 'inicial',            emoji: '👋', color: '#6b7280', is_initial: true, description: 'Dentista ou consultório que acabou de chegar.' },
    { name: 'Em conversa',              slug: 'em-conversa',        emoji: '💬', color: '#3b82f6', description: 'Conversando para entender o volume e o tipo de trabalho.' },
    { name: 'Visita ao consultório',    slug: 'visita-consultorio', emoji: '🚗', color: '#06b6d4', description: 'Visita feita ou combinada para apresentar o laboratório.' },
    { name: 'Tabela de preços enviada', slug: 'tabela-enviada',     emoji: '📄', color: '#f59e0b', description: 'Recebeu a tabela de preços e os prazos.' },
    { name: 'Primeiro trabalho',        slug: 'primeiro-trabalho',  emoji: '🦷', color: '#8b5cf6', description: 'Mandou o primeiro caso para o laboratório.' },
    { name: 'Cliente ativo',            slug: 'cliente-ativo',      emoji: '✅', color: '#10b981', is_won: true, description: 'Manda trabalhos com frequência.' },
    { name: 'Perdido',                  slug: 'perdido',            emoji: '❌', color: '#ef4444', is_lost: true, description: 'Não quis seguir ou parou de responder.' },
  ],
} as const;

// ─── Chaves desligadas ───────────────────────────────────────────
export interface ChaveDaConta {
  key: string;
  value: string;
}

export interface ChavesDesligadasDoLaboratorio {
  /** TenantSetting (tenant_id = a conta do laboratório). */
  daConta: ChaveDaConta[];
  /** GlobalSetting: toda chave termina em _<tenantId>. */
  globaisDaConta: ChaveDaConta[];
}

const DESLIGADO = 'false';

/** Configurações por conta guardadas na GlobalSetting como `<CHAVE>_<tenantId>`. */
const GLOBAIS_DESLIGADAS: ReadonlyArray<readonly [string, string]> = [
  ['RECALL_PREVENTIVO_ENABLED', DESLIGADO],
  ['TASK_ALERTS_ENABLED', DESLIGADO],
  ['REMINDER_CONFIG', JSON.stringify({ enabled: false })],
  ['APPOINTMENT_CONFIRMATION_ENABLED', DESLIGADO],
  ['APPOINTMENT_RESCHEDULED_ENABLED', DESLIGADO],
  ['PAYMENT_CONFIRMATION_ENABLED', DESLIGADO],
  ['BIRTHDAY_GREETING', JSON.stringify({ enabled: false, message2_enabled: false, message3_enabled: false })],
  // Régua de cobrança (7 marcos), cobrar atrasados, apresentação do Financeiro e carnê
  ['BOLETO_1D_ANTES', DESLIGADO],
  ['BOLETO_NO_DIA', DESLIGADO],
  ['BOLETO_ATRASO_1D', DESLIGADO],
  ['BOLETO_ATRASO_2D', DESLIGADO],
  ['BOLETO_ATRASO_3D', DESLIGADO],
  ['BOLETO_ATRASO_15D', DESLIGADO],
  ['BOLETO_ATRASO_30D', DESLIGADO],
  ['BOLETO_ATRASADO', DESLIGADO],
  ['BOLETO_INTRO_ENABLED', DESLIGADO],
  ['BOLETO_DELIVERY_ENABLED', DESLIGADO],
  // Missões da semana (sem lista: nada de texto padrão)
  ['COMMISSION_MISSIONS', JSON.stringify({ enabled: false, missions: [] })],
  // Extração noturna de memória e pesquisa pós-atendimento (as duas nascem ligadas)
  ['MEMORY_BATCH_ENABLED', DESLIGADO],
  ['POST_CARE_CONFIG', JSON.stringify({ enabled: false })],
];

function exigirConta(tenantId: unknown): string {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new Error('[lab-defaults] conta do laboratório ausente');
  }
  return tenantId;
}

/** As chaves desligadas desta conta de laboratório (só dados; não grava nada). */
export function chavesDesligadasDoLaboratorio(tenantId: string): ChavesDesligadasDoLaboratorio {
  const conta = exigirConta(tenantId);
  const daConta: ChaveDaConta[] = [
    ...AI_CHIP_PURPOSES.map((p) => ({ key: aiEnabledKey(p), value: DESLIGADO })),
    { key: 'AFTER_HOURS_AI_ENABLED', value: DESLIGADO },
    // Perfil da IA: sem 2ª tentativa de agendamento (o resto fica no padrão do código).
    ...AI_CHIP_PURPOSES.map((p) => ({ key: aiProfileKey(p), value: JSON.stringify({ schedulingRetryMin: 0 }) })),
  ];
  const globaisDaConta = GLOBAIS_DESLIGADAS.map(([chave, value]) => ({ key: chaveConfigDaConta(chave, conta), value }));
  return { daConta, globaisDaConta };
}

export interface ResultadoEnsureLab {
  /** TenantSetting gravadas agora (as que faltavam). */
  daConta: number;
  /** GlobalSetting gravadas agora (as que faltavam). */
  globais: number;
}

/**
 * Grava SÓ as chaves desligadas que faltam (createMany + skipDuplicates): chave
 * que a conta já tem, com qualquer valor, fica como está. Aceita o `tx` da
 * transação ou o PrismaClient.
 */
export async function ensureLabDefaults(prisma: PrismaClient | any, tenantId: string): Promise<ResultadoEnsureLab> {
  const conta = exigirConta(tenantId);
  const { daConta, globaisDaConta } = chavesDesligadasDoLaboratorio(conta);
  const t = await prisma.tenantSetting.createMany({
    data: daConta.map((c) => ({ tenant_id: conta, key: c.key, value: c.value })),
    skipDuplicates: true,
  });
  const g = await prisma.globalSetting.createMany({
    data: globaisDaConta.map((c) => ({ key: c.key, value: c.value })),
    skipDuplicates: true,
  });
  return { daConta: t?.count ?? 0, globais: g?.count ?? 0 };
}

export interface SeedDoLaboratorio {
  grupos: number;
  servicos: number;
  categorias: number;
  funil: boolean;
  chaves: ResultadoEnsureLab;
}

/**
 * Popula a conta de laboratório: grupos, serviços, categorias financeiras, funil
 * e chaves desligadas. Idempotente: só cria o que falta, nunca atualiza nem apaga
 * (preço e nome que o laboratório mudou ficam). Sem anamnese.
 *
 * Usa createMany para caber no tempo da transação da criação.
 */
export async function seedLabTenantDefaults(prisma: PrismaClient | any, tenantId: string): Promise<SeedDoLaboratorio> {
  const conta = exigirConta(tenantId);

  // 1) Grupos de prótese
  const grupos = await prisma.specialty.createMany({
    data: GRUPOS_DE_PROTESE.map((g) => ({ tenant_id: conta, name: g.name, description: g.description })),
    skipDuplicates: true,
  });
  const linhas: Array<{ id: string; name: string }> = await prisma.specialty.findMany({
    where: { tenant_id: conta, name: { in: GRUPOS_DE_PROTESE.map((g) => g.name) } },
    select: { id: true, name: true },
  });
  const grupoPorNome = new Map((linhas ?? []).map((l) => [l.name, l.id]));

  // 2) Serviços: preço 0 (obriga a revisão antes de vender), na venda rápida, sem comissão
  const servicos = await prisma.procedure.createMany({
    data: SERVICOS_DE_PROTESE.map((s) => ({
      tenant_id: conta,
      specialty_id: grupoPorNome.get(s.grupo) ?? null,
      name: s.name,
      base_price: 0,
      quick_sale: true,
      commissionable: false,
    })),
    skipDuplicates: true,
  });

  // 3) Categorias financeiras
  const categorias = await prisma.financialCategory.createMany({
    data: CATEGORIAS_FINANCEIRAS_DO_LABORATORIO.map((c) => ({
      tenant_id: conta,
      type: c.type,
      name: c.name,
      icon: c.icon,
      is_default: true,
    })),
    skipDuplicates: true,
  });

  // 4) Funil de captação (só se a conta ainda não tem um com este slug)
  const f = FUNIL_CAPTACAO_DE_DENTISTAS;
  const existente = await prisma.pipeline.findFirst({
    where: { tenant_id: conta, slug: f.slug },
    select: { id: true },
  });
  if (!existente) {
    await prisma.pipeline.create({
      data: {
        tenant_id: conta,
        name: f.name,
        slug: f.slug,
        description: f.description,
        color: f.color,
        is_default: true,
        position: 0,
        stages: {
          create: f.stages.map((s, i) => ({
            name: s.name,
            slug: s.slug,
            emoji: s.emoji,
            color: s.color,
            description: s.description,
            position: i,
            is_initial: 'is_initial' in s ? s.is_initial : false,
            is_won: 'is_won' in s ? s.is_won : false,
            is_lost: 'is_lost' in s ? s.is_lost : false,
          })),
        },
      },
    });
  }

  // 5) Chaves desligadas
  const chaves = await ensureLabDefaults(prisma, conta);

  return {
    grupos: grupos?.count ?? 0,
    servicos: servicos?.count ?? 0,
    categorias: categorias?.count ?? 0,
    funil: !existente,
    chaves,
  };
}
