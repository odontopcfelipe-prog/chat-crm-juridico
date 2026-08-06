import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeBrazilianPhone, brazilPhoneMatchVariants } from '../common/utils/phone';

export interface CleanupResult {
  totalDuplicatesFound: number;
  mergedLeads: number;
  updatedPhones: number;
  updatedPatients: number;
  /** Leads (contatos WhatsApp) renomeados pro nome do CADASTRO do paciente. */
  renamedLeads: number;
  /** Pacientes SEM lead (ex.: importados) que foram LINKADOS ao contato WhatsApp
   *  do mesmo número — fecha o "2 contatos" (paciente com nome + lead com número). */
  linkedPatients: number;
  /** Duplicatas que NÃO foram mescladas por segurança (ambos os lados têm
   *  paciente) — precisam de decisão manual. */
  skipped: number;
  errors: string[];
}

@Injectable()
export class LeadsCleanupService {
  private readonly logger = new Logger(LeadsCleanupService.name);
  /** Erro sentinela: o merge foi abortado porque o source deixou de ser seguro
   *  de deletar (ganhou paciente/contrato/etc. numa corrida). Não é falha real. */
  private static readonly MERGE_ABORTED_UNSAFE = 'MERGE_ABORTED_UNSAFE_SOURCE';

  constructor(private prisma: PrismaService) {}

  /**
   * Unifica contatos duplicados do MESMO telefone e padroniza o formato pro
   * canônico (55 + DDD + 8 díg). Duplicata nasce quando o mesmo número foi salvo
   * em formatos diferentes (13 díg com o 9, "+55 (82) 9…" formatado, sem o 55) e o
   * casamento por igualdade exata não os reconhece como o mesmo contato.
   *
   * @param tenantId  quando informado, limita a varredura àquele tenant (botão da
   *   clínica) e também normaliza os telefones dos PACIENTES. Sem ele, roda global
   *   (manutenção) só nos leads. O merge NUNCA cruza tenant.
   */
  async deduplicatePhones(tenantId?: string): Promise<CleanupResult> {
    const result: CleanupResult = {
      totalDuplicatesFound: 0,
      mergedLeads: 0,
      updatedPhones: 0,
      updatedPatients: 0,
      renamedLeads: 0,
      linkedPatients: 0,
      skipped: 0,
      errors: [],
    };

    const BATCH_SIZE = 500;
    let cursor: string | undefined = undefined;
    let totalProcessed = 0;
    const scanWhere = tenantId ? { tenant_id: tenantId } : {};

    this.logger.log(`Iniciando deduplicação de telefones${tenantId ? ` (tenant ${tenantId})` : ' (global)'}...`);

    while (true) {
      const batch: { id: string; phone: string; tenant_id: string | null }[] = cursor
        ? await this.prisma.lead.findMany({
            where: scanWhere,
            take: BATCH_SIZE,
            skip: 1,
            cursor: { id: cursor },
            select: { id: true, phone: true, tenant_id: true },
            orderBy: { id: 'asc' },
          })
        : await this.prisma.lead.findMany({
            where: scanWhere,
            take: BATCH_SIZE,
            select: { id: true, phone: true, tenant_id: true },
            orderBy: { id: 'asc' },
          });

      if (batch.length === 0) break;

      // Fora do canônico: 13 díg com o 9, string formatada, 11/10 díg, sem o 55.
      // (Antes só pegava 13-díg-com-9; agora qualquer telefone não-canônico.)
      const leadsWithOldFormat = batch.filter((lead) => {
        if (!lead.phone) return false;
        const canon = normalizeBrazilianPhone(lead.phone);
        return !!canon && canon !== lead.phone;
      });

      for (const oldLead of leadsWithOldFormat) {
        try {
          const normalizedPhone = normalizeBrazilianPhone(oldLead.phone);

          // Duplicata é DENTRO do tenant (@@unique([tenant_id, phone])).
          const twin = await this.prisma.lead.findFirst({
            where: { phone: normalizedPhone, tenant_id: oldLead.tenant_id, id: { not: oldLead.id } },
            select: { id: true },
          });

          if (twin) {
            // DUPLICATA: escolhe a direção SEGURA (o lead deletado nunca pode ter
            // paciente — Patient.lead_id é onDelete:SetNull, deletar órfãozaria o
            // histórico clínico).
            const dir = await this.resolveDirection(oldLead, twin.id);
            if (!dir) {
              result.skipped++;
              this.logger.warn(
                `Skip: ${oldLead.id} × ${twin.id} (${normalizedPhone}) — ambos têm paciente, precisa revisão manual`,
              );
              continue;
            }
            result.totalDuplicatesFound++;
            try {
              await this.mergeLeads(dir.sourceId, dir.targetId);
              result.mergedLeads++;
              if (dir.targetNeedsCanonical) {
                await this.prisma.lead
                  .update({ where: { id: dir.targetId }, data: { phone: normalizedPhone } })
                  .catch((e: any) => { if (e?.code !== 'P2002') throw e; });
              }
              this.logger.log(`Merge: ${dir.sourceId} → ${dir.targetId} (${normalizedPhone})`);
            } catch (e: any) {
              if (e?.message !== LeadsCleanupService.MERGE_ABORTED_UNSAFE) throw e;
              result.skipped++;
              this.logger.warn(`Skip (corrida): source ${dir.sourceId} ganhou dado durante o merge — revisão manual`);
            }
          } else {
            // Sem gêmeo: só padroniza o formato. Se numa corrida um gêmeo canônico
            // surgiu (P2002), re-resolve e mescla em vez de estourar.
            try {
              await this.prisma.lead.update({
                where: { id: oldLead.id },
                data: { phone: normalizedPhone },
              });
              result.updatedPhones++;
              this.logger.log(`Atualizado: ${oldLead.id}: ${oldLead.phone} → ${normalizedPhone}`);
            } catch (e: any) {
              if (e?.code !== 'P2002') throw e;
              const raced = await this.prisma.lead.findFirst({
                where: { phone: normalizedPhone, tenant_id: oldLead.tenant_id, id: { not: oldLead.id } },
                select: { id: true },
              });
              if (raced) {
                const dir = await this.resolveDirection(oldLead, raced.id);
                if (dir) {
                  try {
                    await this.mergeLeads(dir.sourceId, dir.targetId);
                    result.mergedLeads++;
                    if (dir.targetNeedsCanonical) {
                      await this.prisma.lead
                        .update({ where: { id: dir.targetId }, data: { phone: normalizedPhone } })
                        .catch((err: any) => { if (err?.code !== 'P2002') throw err; });
                    }
                  } catch (mErr: any) {
                    if (mErr?.message !== LeadsCleanupService.MERGE_ABORTED_UNSAFE) throw mErr;
                    result.skipped++;
                  }
                } else {
                  result.skipped++;
                }
              }
            }
          }
        } catch (error: any) {
          const msg = `Erro ao processar lead ${oldLead.id} (${oldLead.phone}): ${error.message}`;
          this.logger.error(msg);
          result.errors.push(msg);
        }
      }

      totalProcessed += batch.length;
      cursor = batch[batch.length - 1].id;
      if (batch.length < BATCH_SIZE) break;
      this.logger.log(`Batch processado: ${totalProcessed} leads verificados até agora...`);
    }

    // Normaliza os telefones dos PACIENTES do tenant (sem merge — Patient não tem
    // unique de phone, só converge o formato pro casamento futuro). Só no modo
    // tenant-scoped (o botão da clínica); o global é manutenção de leads.
    if (tenantId) {
      const pats = await this.prisma.patient.findMany({
        where: { tenant_id: tenantId, phone: { not: null } },
        select: { id: true, phone: true },
      });
      for (const p of pats) {
        if (!p.phone) continue;
        const canon = normalizeBrazilianPhone(p.phone);
        if (canon && canon !== p.phone) {
          await this.prisma.patient
            .update({ where: { id: p.id }, data: { phone: canon } })
            .then(() => { result.updatedPatients++; })
            .catch(() => undefined);
        }
      }

      // Sincroniza o nome do LEAD (contato WhatsApp) com o CADASTRO do paciente — o nome
      // do cadastro é a fonte da verdade. Corrige contatos que ficaram com o pushName/
      // apelido antigo do WhatsApp em vez do nome cadastrado.
      const patsWithLead = await this.prisma.patient.findMany({
        where: { tenant_id: tenantId, lead_id: { not: null } },
        select: { name: true, lead: { select: { id: true, name: true } } },
      });
      for (const p of patsWithLead) {
        const nome = (p.name || '').trim();
        if (!nome || nome === 'Paciente sem nome' || !p.lead || p.lead.name === nome) continue;
        await this.prisma.lead
          .update({ where: { id: p.lead.id }, data: { name: nome } })
          .then(() => { result.renamedLeads++; })
          .catch(() => undefined);
      }

      // BACKFILL do "2 contatos": paciente SEM lead (ex.: importado do Asaas) mas com
      // telefone e nome real. Acha o contato WhatsApp pelo número (variantes com/sem
      // 9/55), LINKA o paciente a ele e adota o nome do cadastro. Não rouba lead que
      // já é de outro paciente (número compartilhado). A conversa já existe no lead —
      // linkar basta pro paciente enxergá-la, e renomear deixa achável na busca/agenda.
      const unlinked = await this.prisma.patient.findMany({
        where: { tenant_id: tenantId, lead_id: null, phone: { not: null } },
        select: { id: true, name: true, phone: true },
      });
      for (const p of unlinked) {
        const nome = (p.name || '').trim();
        if (!p.phone || !nome || nome === 'Paciente sem nome') continue;
        const lead = await this.prisma.lead.findFirst({
          where: { tenant_id: tenantId, phone: { in: brazilPhoneMatchVariants(p.phone) } },
          select: { id: true, name: true },
        });
        if (!lead) continue;
        const claimed = await this.prisma.patient.findFirst({
          where: { lead_id: lead.id },
          select: { id: true },
        });
        if (claimed) continue; // número compartilhado — não rouba o lead de outro paciente
        const linked = await this.prisma.patient
          .update({ where: { id: p.id }, data: { lead_id: lead.id } })
          .then(() => true)
          .catch(() => false);
        if (!linked) continue;
        result.linkedPatients++;
        if (lead.name !== nome) {
          await this.prisma.lead
            .update({ where: { id: lead.id }, data: { name: nome } })
            .then(() => { result.renamedLeads++; })
            .catch(() => undefined);
        }
      }
    }

    this.logger.log(`Deduplicação concluída. Total verificado: ${totalProcessed}. Resultado: ${JSON.stringify(result)}`);
    return result;
  }

  /** Estatísticas do lead pra desempatar qual manter (quando os dois são seguros
   *  de deletar). */
  private async leadStats(leadId: string): Promise<{ convs: number; isClient: boolean; createdAt: Date | null }> {
    const [convs, lead] = await Promise.all([
      this.prisma.conversation.count({ where: { lead_id: leadId } }),
      this.prisma.lead.findUnique({ where: { id: leadId }, select: { is_client: true, created_at: true } }),
    ]);
    return {
      convs,
      isClient: !!(lead as any)?.is_client,
      createdAt: (lead as any)?.created_at ?? null,
    };
  }

  /** Tabelas de DADO DE NEGÓCIO que, se apontarem pro lead, tornam DELETAR o lead
   *  uma perda irreversível (cascade-delete) ou um órfão silencioso (SetNull). Um
   *  lead só pode ser o SOURCE (deletado) de um merge se NENHUMA delas apontar pra
   *  ele. NÃO entram aqui as relações que mergeLeads MOVE pro target (não se
   *  perdem): Conversation, Task, AiMemory, FollowupEnrollment (com a mensagem em
   *  aprovação junto) e BroadcastItem (envio em fila). Fica DE FORA, como perda
   *  aceitável, só LeadStageHistory — audit de transição de estágio que TODO lead
   *  tem (bloquear por ele impediria qualquer merge) e é do lado duplicado que
   *  some. As métricas da Central usam DispatchLog, não estas tabelas. */
  private async leadDeletionBlockers(prisma: any, leadId: string): Promise<number> {
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

  private async isLeadSafeToDelete(leadId: string): Promise<boolean> {
    return (await this.leadDeletionBlockers(this.prisma, leadId)) === 0;
  }

  /**
   * Decide qual lead MANTER (target) e qual DELETAR (source) num par duplicado.
   * INVARIANTE DE SEGURANÇA: o source (deletado) NÃO pode ter paciente NEM nenhum
   * registro de negócio (contrato, honorário, cliente-gateway, financeiro, agenda,
   * nota fiscal, nota interna, espera, perfil) — senão deletá-lo apagaria/órfãozaria
   * dado real. Se NENHUM lado é seguro de deletar, retorna null (revisão manual).
   * `oldLead` é o de formato legado; o twin já está canônico.
   */
  private async resolveDirection(
    oldLead: { id: string; phone: string; tenant_id: string | null },
    twinId: string,
  ): Promise<{ targetId: string; sourceId: string; targetNeedsCanonical: boolean } | null> {
    const [oldSafe, twinSafe] = await Promise.all([
      this.isLeadSafeToDelete(oldLead.id),
      this.isLeadSafeToDelete(twinId),
    ]);
    if (!oldSafe && !twinSafe) return null; // os dois carregam dado → manual

    let targetId: string;
    let sourceId: string;
    if (oldSafe && !twinSafe) {
      sourceId = oldLead.id; targetId = twinId; // mantém o twin (tem dado)
    } else if (!oldSafe && twinSafe) {
      sourceId = twinId; targetId = oldLead.id; // mantém o legado (tem dado) — caso Vandeildo
    } else {
      // Ambos seguros de deletar (vazios) → mantém o mais "rico": is_client >
      // +conversas > +antigo. Deleta o outro.
      const [o, t] = await Promise.all([this.leadStats(oldLead.id), this.leadStats(twinId)]);
      let oldWins: boolean;
      if (o.isClient !== t.isClient) oldWins = o.isClient;
      else if (o.convs !== t.convs) oldWins = o.convs > t.convs;
      else if (o.createdAt && t.createdAt) oldWins = o.createdAt <= t.createdAt;
      else oldWins = false; // desempate: mantém o twin (já canônico)
      targetId = oldWins ? oldLead.id : twinId;
      sourceId = oldWins ? twinId : oldLead.id;
    }
    return { targetId, sourceId, targetNeedsCanonical: targetId === oldLead.id };
  }

  /**
   * Move as relações do lead source para o target e deleta o source, numa
   * transaction. PRÉ-CONDIÇÃO (garantida pelo resolveDirection): o source não tem
   * paciente. FollowupEnrollment do source NÃO é movido (tem @@unique[lead_id,
   * sequence_id] → colidiria) — cai no cascade do delete; aceitável, o source é o
   * lado pobre.
   */
  private async mergeLeads(sourceLeadId: string, targetLeadId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // TOCTOU: reconfirma DENTRO da transação que o source continua seguro de
      // deletar (entre o resolveDirection e aqui, alguém pode ter anexado
      // paciente/contrato/etc. a ele). Se surgiu qualquer blocker, ABORTA — nunca
      // deleta dado. O caller trata este erro como "pulado / revisão manual".
      const blockers = await this.leadDeletionBlockers(tx, sourceLeadId);
      if (blockers > 0) throw new Error(LeadsCleanupService.MERGE_ABORTED_UNSAFE);

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
        if (sourceLead.tags && sourceLead.tags.length > 0) {
          updates.tags = [...new Set([...targetLead.tags, ...sourceLead.tags])];
        }
        if (Object.keys(updates).length > 0) {
          await tx.lead.update({ where: { id: targetLeadId }, data: updates });
        }
      }

      // Deleta o source (o resto das relações cai no cascade)
      await tx.lead.delete({ where: { id: sourceLeadId } });
    });
  }
}
