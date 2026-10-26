/**
 * Trocar o telefone no cadastro do paciente leva o contato do WhatsApp (Lead) junto.
 *
 * O WhatsApp (chat, lembretes) sai pelo telefone do CONTATO ligado ao paciente
 * (patient.lead_id), não pelo do cadastro. Antes, corrigir o telefone no cadastro
 * deixava o contato no número velho e tudo seguia indo pra ele (caso real: número
 * velho sem WhatsApp → toda mensagem "não enviada", lembrete da consulta perdido).
 *
 * Só age quando o contato estava no número ANTIGO do cadastro (contato de outro
 * número, ex.: WhatsApp do responsável de um menor, é ligação de propósito) e o
 * número novo é um telefone BR válido. Aí:
 *  - nenhum contato da clínica tem o número novo → o contato do paciente passa a usá-lo;
 *  - UM outro contato tem o número novo (a pessoa já falou por ele no WhatsApp), não é
 *    de outro paciente e não tem dado de negócio → os dois viram um só: fica o contato
 *    do paciente (com o histórico) e as conversas do outro vêm junto;
 *  - o número novo é o contato de OUTRO paciente (família) → não mexe e avisa;
 *  - outro contato com dado de negócio (agenda, financeiro, contrato…), ou mais de um
 *    contato com o número novo → não mexe e pede revisão.
 *
 * Função pura sobre o Prisma (sem DI). Tudo dentro da clínica do paciente.
 */
import { toAlertPhone } from '@crm/shared';
import { normalizeBrazilianPhone, brazilPhoneMatchVariants } from '../common/utils/phone';
import { leadDeletionBlockers, moverContatoPara } from '../leads/lead-merge';

/** O que aconteceu com o contato ('erro' = falha técnica; o cadastro já foi salvo). */
export type ContatoWhatsapp = 'atualizado' | 'unido' | 'numero_de_outro_paciente' | 'revisar' | 'erro';

const OUTRO_TEM_DADO = 'CONTATO_COM_DADO_DE_NEGOCIO';
const digitos = (s?: string | null) => (s || '').replace(/\D/g, '');
const jids = (telefone: string) => brazilPhoneMatchVariants(telefone).map((v) => `${v}@s.whatsapp.net`);

/** Mesmo assinante? (só muda o 55 e/ou o 9 do celular) */
export function mesmoNumero(a?: string | null, b?: string | null): boolean {
  const da = digitos(a);
  const db = digitos(b);
  if (!da || !db) return da === db;
  return brazilPhoneMatchVariants(da).includes(db);
}

/**
 * Índice único parcial (lead_id, inbox_id) com status <> 'ENCERRADO': se os dois
 * contatos têm conversa ativa no MESMO setor, fica a de mais mensagens (empate: a
 * mais recente); as mensagens da outra passam pra ela e a outra é encerrada. Nada
 * é apagado.
 */
async function juntarConversasDoMesmoSetor(tx: any, sourceLeadId: string, targetLeadId: string) {
  const ativas: { id: string; lead_id: string; inbox_id: string; last_message_at: Date }[] =
    await tx.conversation.findMany({
      where: { lead_id: { in: [sourceLeadId, targetLeadId] }, inbox_id: { not: null }, status: { not: 'ENCERRADO' } },
      select: { id: true, lead_id: true, inbox_id: true, last_message_at: true },
    });
  const porSetor = new Map<string, typeof ativas>();
  for (const c of ativas) porSetor.set(c.inbox_id, [...(porSetor.get(c.inbox_id) ?? []), c]);

  for (const grupo of porSetor.values()) {
    if (!grupo.some((c) => c.lead_id === sourceLeadId) || !grupo.some((c) => c.lead_id === targetLeadId)) continue;
    const comTotal = await Promise.all(
      grupo.map(async (c) => ({ ...c, msgs: await tx.message.count({ where: { conversation_id: c.id } }) })),
    );
    const quando = (c: { last_message_at: Date }) => new Date(c.last_message_at).getTime();
    comTotal.sort((a, b) => b.msgs - a.msgs || quando(b) - quando(a));
    const [fica, ...saem] = comTotal;
    for (const c of saem) {
      await tx.message.updateMany({ where: { conversation_id: c.id }, data: { conversation_id: fica.id } });
      await tx.conversation.update({ where: { id: c.id }, data: { status: 'ENCERRADO', ai_mode: false } });
    }
    const ultima = Math.max(...comTotal.map(quando));
    if (ultima > quando(fica)) await tx.conversation.update({ where: { id: fica.id }, data: { last_message_at: new Date(ultima) } });
  }
}

/**
 * Leva o contato do WhatsApp do paciente para o telefone novo do cadastro.
 * null = nada a fazer (número inválido, sem contato, contato já no número novo ou
 * contato que não seguia o número antigo do cadastro).
 */
export async function levarContatoParaTelefoneNovo(
  prisma: any,
  args: { tenantId: string; patientId: string; leadId: string; telefoneAntes: string | null; telefone: string },
  logger: { log: (m: string) => void; warn: (m: string) => void },
): Promise<ContatoWhatsapp | null> {
  const { tenantId, patientId, leadId, telefoneAntes, telefone } = args;
  if (!toAlertPhone(telefone)) {
    if (digitos(telefone)) logger.warn(`[PATIENT PHONE] Paciente ${patientId}: telefone novo não é um telefone BR válido — contato ${leadId} não mudou`);
    return null;
  }

  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenant_id: tenantId }, select: { id: true, phone: true } });
  if (!lead || mesmoNumero(lead.phone, telefone) || !mesmoNumero(lead.phone, telefoneAntes)) return null;
  const novo = normalizeBrazilianPhone(telefone);
  // Conversas do paciente que guardam o número velho (tique de "lida" vai pra ele).
  const jidVelho = { lead_id: leadId, external_id: { in: jids(lead.phone) } };

  const outros: { id: string; whatsapp_invalid_at: Date | null }[] = await prisma.lead.findMany({
    where: { tenant_id: tenantId, phone: { in: brazilPhoneMatchVariants(telefone) }, id: { not: leadId } },
    select: { id: true, whatsapp_invalid_at: true },
  });

  if (outros.length === 0) {
    await prisma.$transaction([
      // Número novo: a marca "sem WhatsApp" era do número velho.
      prisma.lead.update({ where: { id: leadId }, data: { phone: novo, whatsapp_invalid_at: null } }),
      prisma.conversation.updateMany({ where: jidVelho, data: { external_id: `${novo}@s.whatsapp.net` } }),
    ]);
    logger.log(`[PATIENT PHONE] Contato ${leadId} do paciente ${patientId} passou para o telefone novo`);
    return 'atualizado';
  }

  const deOutroPaciente = await prisma.patient.findFirst({
    where: { tenant_id: tenantId, lead_id: { in: outros.map((o) => o.id) }, id: { not: patientId } },
    select: { id: true },
  });
  if (deOutroPaciente) {
    logger.warn(`[PATIENT PHONE] Paciente ${patientId}: o telefone novo é o contato do paciente ${deOutroPaciente.id} — contato ${leadId} não mudou`);
    return 'numero_de_outro_paciente';
  }
  if (outros.length > 1) {
    logger.warn(`[PATIENT PHONE] Paciente ${patientId}: ${outros.length} contatos com o telefone novo (${outros.map((o) => o.id).join(', ')}) — juntar à mão`);
    return 'revisar';
  }
  const [outro] = outros;

  try {
    await prisma.$transaction(
      async (tx: any) => {
        // Confere DENTRO da transação: o contato que some não pode ter dado de negócio.
        if ((await leadDeletionBlockers(tx, outro.id)) > 0) throw new Error(OUTRO_TEM_DADO);
        await juntarConversasDoMesmoSetor(tx, outro.id, leadId);
        // AiMemory é única por contato: fica a do outro (é a da conversa de verdade).
        if (await tx.aiMemory.findUnique({ where: { lead_id: outro.id } })) {
          await tx.aiMemory.deleteMany({ where: { lead_id: leadId } });
        }
        await moverContatoPara(tx, outro.id, leadId);
        // O outro já foi apagado: o número novo está livre (Lead @@unique[tenant_id, phone]).
        // A marca "sem WhatsApp" passa a ser a do número novo.
        await tx.lead.update({ where: { id: leadId }, data: { phone: novo, whatsapp_invalid_at: outro.whatsapp_invalid_at } });
        await tx.conversation.updateMany({ where: jidVelho, data: { external_id: `${novo}@s.whatsapp.net` } });
      },
      { timeout: 20_000 },
    );
  } catch (e: any) {
    if (e?.message !== OUTRO_TEM_DADO) throw e;
    logger.warn(`[PATIENT PHONE] Paciente ${patientId}: o contato ${outro.id} do telefone novo tem dado de negócio — juntar à mão`);
    return 'revisar';
  }
  logger.log(`[PATIENT PHONE] Paciente ${patientId}: contato ${outro.id} (telefone novo) unido ao contato ${leadId}`);
  return 'unido';
}
