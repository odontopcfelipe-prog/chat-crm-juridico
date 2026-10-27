/**
 * F2 parte 4 do laboratório — o que a vigia diária conta em cada laboratório.
 *
 * Tudo aqui tem de ser ZERO numa conta de laboratório: entidade clínica (I2),
 * uso ou memória de IA, comissão de profissional, agenda de clínica, chip de
 * outra conta, cobrança Asaas sem a chave do próprio laboratório. Qualquer valor acima de zero vira e-mail ao SUPER_ADMIN
 * (lab-sentinel.service.ts).
 *
 * Função pura com o Prisma por parâmetro (tipada pelo client: o tsc confere os
 * campos de cada where). Só lê.
 */
import type { PrismaService } from '../prisma/prisma.service';
import { TIPOS_DE_AGENDA_DO_LABORATORIO } from './agenda-do-laboratorio';

export { TIPOS_DE_AGENDA_DO_LABORATORIO };

/** Contagens ao mesmo tempo (não ocupa o pool de conexões das requisições). */
const POR_VEZ = 4;

export type ContagemDaVigia = Record<string, number>;

/** Conta, num laboratório, tudo o que não pode existir nele. */
export async function contarForaDoLugar(prisma: PrismaService, labId: string): Promise<ContagemDaVigia> {
  const doPaciente = { patient: { tenant_id: labId } };
  const daConversa = { conversation: { tenant_id: labId } };
  const [chips, chipsDeOutrasContas, chaveAsaas] = await Promise.all([
    prisma.instance.findMany({ where: { tenant_id: labId }, select: { name: true } }),
    prisma.instance.findMany({ where: { OR: [{ tenant_id: null }, { tenant_id: { not: labId } }] }, select: { name: true } }),
    prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: labId, key: 'ASAAS_API_KEY' } },
      select: { value: true },
    }),
  ]);
  const nomesDosChips = chips.map((c) => c.name);
  // Chip de outra conta = Instance que EXISTE em outra conta (chip apagado pelo
  // próprio laboratório não conta: o nome some de Instance mas fica nas mensagens).
  const nomesDeOutrasContas = chipsDeOutrasContas.map((c) => c.name);
  const temChaveAsaas = !!chaveAsaas?.value?.trim();

  // Cada contagem é uma função: rodam em lotes de POR_VEZ, não todas de uma vez.
  const contagens: Array<[string, () => Promise<number>]> = [
    ['Odontograma', () => prisma.odontogram.count({ where: doPaciente })],
    ['Registro de dente no odontograma', () => prisma.toothRecord.count({ where: { odontogram: doPaciente } })],
    ['Anamnese', () => prisma.anamnesis.count({ where: doPaciente })],
    ['Prontuário', () => prisma.medicalRecord.count({ where: doPaciente })],
    ['Evolução clínica', () => prisma.clinicalNote.count({ where: { medical_record: doPaciente } })],
    ['Imagem clínica', () => prisma.clinicalImage.count({ where: doPaciente })],
    ['Radiografia', () => prisma.radiographyExam.count({ where: { tenant_id: labId } })],
    ['Alergia', () => prisma.patientAllergy.count({ where: doPaciente })],
    ['Medicação', () => prisma.patientMedication.count({ where: doPaciente })],
    ['Aplicação estética', () => prisma.estheticApplication.count({ where: { tenant_id: labId } })],
    ['Reação adversa', () => prisma.adverseReaction.count({ where: { tenant_id: labId } })],
    [
      'Assinatura de contrato',
      () => prisma.contractSignature.count({ where: { OR: [{ lead: { tenant_id: labId } }, daConversa] } }),
    ],
    ['Contrato odontológico', () => prisma.contract.count({ where: { quote: doPaciente } })],
    [
      'Plano ligado a contrato',
      () => prisma.treatmentPlan.count({ where: { ...doPaciente, contract_signature_id: { not: null } } }),
    ],
    ['Retorno / manutenção', () => prisma.maintenanceTask.count({ where: { tenant_id: labId } })],
    ['Alerta de retorno', () => prisma.returnAlert.count({ where: { tenant_id: labId } })],
    ['Pesquisa pós-atendimento', () => prisma.postCareSurvey.count({ where: { tenant_id: labId } })],
    ['Acesso ao portal do paciente', () => prisma.portalToken.count({ where: { tenant_id: labId } })],
    ['Simulação de sorriso', () => prisma.smileSimulation.count({ where: { tenant_id: labId } })],
    ['Indicação', () => prisma.referral.count({ where: { tenant_id: labId } })],
    ['Comissão de afiliado', () => prisma.affiliateReferral.count({ where: { tenant_id: labId } })],
    ['Lista de espera', () => prisma.waitlistEntry.count({ where: { tenant_id: labId } })],
    ['Uso de IA', () => prisma.aiUsage.count({ where: { tenant_id: labId } })],
    ['Memória da IA', () => prisma.memory.count({ where: { tenant_id: labId } })],
    ['Perfil do contato feito pela IA', () => prisma.leadProfile.count({ where: { tenant_id: labId } })],
    ['Comissão de profissional', () => prisma.commission.count({ where: { tenant_id: labId } })],
    [
      'Mensagem enviada pela IA',
      () => prisma.message.count({ where: { ...daConversa, direction: 'out', skill_id: { not: null } } }),
    ],
    [
      'Evento de agenda de clínica',
      () => prisma.calendarEvent.count({
        where: { tenant_id: labId, type: { notIn: [...TIPOS_DE_AGENDA_DO_LABORATORIO] } },
      }),
    ],
    [
      'Mensagem enviada por chip de outra conta',
      () => nomesDeOutrasContas.length
        ? prisma.message.count({ where: { ...daConversa, direction: 'out', instance_name: { in: nomesDeOutrasContas } } })
        : Promise.resolve(0),
    ],
    [
      // Pela conversa (instance_name tem índice em Conversation; em Message, não).
      'Conversa de outra conta no chip do laboratório',
      () => nomesDosChips.length
        ? prisma.conversation.count({
            where: { instance_name: { in: nomesDosChips }, OR: [{ tenant_id: null }, { tenant_id: { not: labId } }] },
          })
        : Promise.resolve(0),
    ],
    [
      'Cobrança Asaas sem a chave do próprio laboratório',
      () => temChaveAsaas
        ? Promise.resolve(0)
        : prisma.paymentGatewayCharge.count({ where: { tenant_id: labId, gateway: 'ASAAS' } }),
    ],
  ];

  const resultado: ContagemDaVigia = {};
  for (let i = 0; i < contagens.length; i += POR_VEZ) {
    const lote = contagens.slice(i, i + POR_VEZ);
    const valores = await Promise.all(lote.map(([, contar]) => contar()));
    lote.forEach(([nome], j) => {
      resultado[nome] = valores[j];
    });
  }
  return resultado;
}

/** Só o que passou de zero. */
export function foraDoLugar(contagem: ContagemDaVigia): ContagemDaVigia {
  const r: ContagemDaVigia = {};
  for (const [nome, n] of Object.entries(contagem)) if (n > 0) r[nome] = n;
  return r;
}
