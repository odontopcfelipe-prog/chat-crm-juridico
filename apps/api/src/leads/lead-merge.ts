/**
 * Unir dois contatos (Lead) da MESMA pessoa — funções puras sobre o Prisma, sem DI,
 * usadas pelo botão "Corrigir telefones" (LeadsCleanupService) e pela troca de
 * telefone no cadastro do paciente (patients/contato-telefone.ts). Ver CLAUDE.md:
 * dependência cruzada entre módulos vira função pura (ciclo de DI derruba a API).
 */

/** Tabelas de DADO DE NEGÓCIO que, se apontarem pro lead, tornam DELETAR o lead
 *  uma perda irreversível (cascade-delete) ou um órfão silencioso (SetNull). Um
 *  lead só pode ser o SOURCE (deletado) de um merge se NENHUMA delas apontar pra
 *  ele. NÃO entram aqui as relações que mergeLeads MOVE pro target (não se
 *  perdem): Conversation, Task, AiMemory, FollowupEnrollment (com a mensagem em
 *  aprovação junto), BroadcastItem (envio em fila), a régua de reativação
 *  (LeadReactivation + LeadDispatch) e a Memory da IA (scope 'lead'). Fica DE FORA, como perda
 *  aceitável, só LeadStageHistory — audit de transição de estágio que TODO lead
 *  tem (bloquear por ele impediria qualquer merge) e é do lado duplicado que
 *  some. As métricas da Central usam DispatchLog, não estas tabelas. */
export async function leadDeletionBlockers(prisma: any, leadId: string): Promise<number> {
  const [patient, contract, pgCustomer, honorario, finTx, calEvent, nota, note, waitlist, profile] = await Promise.all([
    prisma.patient.count({ where: { lead_id: leadId } }),
    prisma.contractSignature.count({ where: { lead_id: leadId } }),
    prisma.paymentGatewayCustomer.count({ where: { lead_id: leadId } }),
    prisma.leadHonorario.count({ where: { lead_id: leadId } }),
    prisma.financialTransaction.count({ where: { lead_id: leadId } }),
    prisma.calendarEvent.count({ where: { lead_id: leadId } }),
    prisma.notaFiscal.count({ where: { lead_id: leadId } }),
    prisma.leadNote.count({ where: { lead_id: leadId } }),
    prisma.waitlistEntry.count({ where: { lead_id: leadId } }),
    prisma.leadProfile.count({ where: { lead_id: leadId } }),
  ]);
  return patient + contract + pgCustomer + honorario + finTx + calEvent + nota + note + waitlist + profile;
}

/**
 * Move as relações do lead source para o target e deleta o source. Roda DENTRO da
 * transação do chamador, que antes confere `leadDeletionBlockers(tx, source) === 0`
 * (o source não pode ter paciente nem dado de negócio). FollowupEnrollment da mesma
 * sequência que o target já tem cai no delete; o resto é movido.
 * NÃO resolve conversa ativa dos dois no MESMO setor (índice único parcial
 * lead_id+inbox_id): quem chama encerra uma delas antes (ver contato-telefone.ts).
 */
export async function moverContatoPara(tx: any, sourceLeadId: string, targetLeadId: string): Promise<void> {
  // Conversas e tasks
  await tx.conversation.updateMany({ where: { lead_id: sourceLeadId }, data: { lead_id: targetLeadId } });
  await tx.task.updateMany({ where: { lead_id: sourceLeadId }, data: { lead_id: targetLeadId } });

  // FollowupEnrollment: MOVE (não perder nurture nem mensagem em APROVAÇÃO
  // humana — FollowupMessage pende da enrollment, não do lead). @@unique
  // [lead_id, sequence_id]: se o target já tem a mesma sequência, apaga a
  // duplicada do source; senão migra pro target.
  const srcEnr = await tx.followupEnrollment.findMany({
    where: { lead_id: sourceLeadId },
    select: { id: true, sequence_id: true },
  });
  if (srcEnr.length) {
    const tgtSeqs = new Set(
      (await tx.followupEnrollment.findMany({ where: { lead_id: targetLeadId }, select: { sequence_id: true } }))
        .map((e: { sequence_id: string }) => e.sequence_id),
    );
    for (const e of srcEnr) {
      if (tgtSeqs.has(e.sequence_id)) {
        await tx.followupEnrollment.delete({ where: { id: e.id } });
      } else {
        await tx.followupEnrollment.update({ where: { id: e.id }, data: { lead_id: targetLeadId } });
        // FollowupMessage.lead_id é coluna DENORMALIZADA (sem FK) e é o que o
        // envio da mensagem APROVADA usa (followup.processor sendMessageDirect).
        // Sem atualizar junto, a mensagem apontaria pro lead deletado e o envio
        // sairia silenciosamente (findUnique null → return).
        await tx.followupMessage.updateMany({
          where: { enrollment_id: e.id },
          data: { lead_id: targetLeadId },
        });
        tgtSeqs.add(e.sequence_id);
      }
    }
  }

  // BroadcastItem: MOVE (não perder envio de campanha em fila). Sem unique
  // (broadcast_id, lead_id) → updateMany direto.
  await tx.broadcastItem.updateMany({ where: { lead_id: sourceLeadId }, data: { lead_id: targetLeadId } });

  // Régua de reativação: MOVE o histórico (antes caía no cascade do delete), mas o
  // ciclo ATIVO do source é encerrado antes — senão o target ficaria com dois ciclos
  // e a pessoa receberia toque em dobro (mesmo status/motivo do encerrarCiclo do worker).
  await tx.leadDispatch.updateMany({
    where: { lead_id: sourceLeadId, status: 'AGENDADO' },
    data: { status: 'CANCELADO', motivo: 'contato unido' },
  });
  await tx.leadReactivation.updateMany({
    where: { lead_id: sourceLeadId, status: 'ATIVA' },
    data: { status: 'CANCELADA', motivo_fim: 'contato unido', ended_at: new Date() },
  });
  await tx.leadReactivation.updateMany({ where: { lead_id: sourceLeadId }, data: { lead_id: targetLeadId } });
  await tx.leadDispatch.updateMany({ where: { lead_id: sourceLeadId }, data: { lead_id: targetLeadId } });

  // Memória da IA por contato (Memory scope='lead', scope_id sem FK): MOVE. Sem isso os
  // fatos aprendidos nas conversas do source ficariam soltos, apontando pro lead apagado.
  await tx.memory.updateMany({ where: { scope: 'lead', scope_id: sourceLeadId }, data: { scope_id: targetLeadId } });

  // AiMemory (unique por lead_id)
  const sourceMemory = await tx.aiMemory.findUnique({ where: { lead_id: sourceLeadId } });
  const targetMemory = await tx.aiMemory.findUnique({ where: { lead_id: targetLeadId } });
  if (sourceMemory && !targetMemory) {
    await tx.aiMemory.update({ where: { lead_id: sourceLeadId }, data: { lead_id: targetLeadId } });
  } else if (sourceMemory && targetMemory) {
    await tx.aiMemory.delete({ where: { lead_id: sourceLeadId } });
  }

  // Preenche campos vazios do target com dados do source
  const sourceLead = await tx.lead.findUnique({ where: { id: sourceLeadId } });
  const targetLead = await tx.lead.findUnique({ where: { id: targetLeadId } });
  if (sourceLead && targetLead) {
    const updates: any = {};
    if (!targetLead.name && sourceLead.name) updates.name = sourceLead.name;
    if (!targetLead.email && sourceLead.email) updates.email = sourceLead.email;
    if (!targetLead.profile_picture_url && sourceLead.profile_picture_url)
      updates.profile_picture_url = sourceLead.profile_picture_url;
    // is_client é promoção que nunca rebaixa: se o source já era cliente, herda.
    if ((sourceLead as any).is_client && !(targetLead as any).is_client) {
      updates.is_client = true;
      if ((sourceLead as any).became_client_at && !(targetLead as any).became_client_at)
        updates.became_client_at = (sourceLead as any).became_client_at;
    }
    // "Pediu pra parar" e "não é paciente" (fornecedor, spam…) valem pra pessoa, não
    // pro registro: se só o source tinha, o target herda (senão a régua e a campanha
    // voltariam a mandar mensagem pra quem pediu pra parar). "Não é paciente" não passa
    // pra contato com ficha de paciente (tiraria o paciente das campanhas).
    if ((sourceLead as any).contact_opt_out_at && !(targetLead as any).contact_opt_out_at) {
      updates.contact_opt_out_at = (sourceLead as any).contact_opt_out_at;
      updates.contact_opt_out_reason = (sourceLead as any).contact_opt_out_reason ?? null;
    }
    if (
      (sourceLead as any).non_patient_category &&
      !(targetLead as any).non_patient_category &&
      (await tx.patient.count({ where: { lead_id: targetLeadId } })) === 0
    ) {
      updates.non_patient_category = (sourceLead as any).non_patient_category;
      updates.non_patient_at = (sourceLead as any).non_patient_at ?? null;
    }
    if (sourceLead.tags && sourceLead.tags.length > 0) {
      updates.tags = [...new Set([...targetLead.tags, ...sourceLead.tags])];
    }
    if (Object.keys(updates).length > 0) {
      await tx.lead.update({ where: { id: targetLeadId }, data: updates });
    }
  }

  // Deleta o source (o resto das relações cai no cascade)
  await tx.lead.delete({ where: { id: sourceLeadId } });
}
