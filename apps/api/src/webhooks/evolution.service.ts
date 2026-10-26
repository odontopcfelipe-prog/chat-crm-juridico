import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ChatGateway } from '../gateway/chat.gateway';
import { LeadsService } from '../leads/leads.service';
import { InboxesService } from '../inboxes/inboxes.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { FollowupService } from '../followup/followup.service';
import { AdminBotService } from '../admin-bot/admin-bot.service';
import { MediaDownloadService } from '../media/media-download.service';
import { FileStorageService } from '../media/filesystem.service';
import { PostCareService } from '../post-care/post-care.service';
import {
  aiEnabledKey,
  aiProfileKey,
  isAiChipPurpose,
  normalizeAiChipProfile,
  REATIVACAO_OPT_OUT_RE,
  ehRecusaDoLead,
  brazilPhoneMatchVariants,
  nonPatientCategoryLabel,
  naoPacienteTriageKey,
  NAO_PACIENTE_ANEXO_JANELA_MS,
} from '@crm/shared';
import { clinicTransferBlockReason } from '../leads/clinic-transfer-guard';
import { loadAdminAlertRecipients } from '../common/utils/admin-alert-recipients';
import { ackSobe, parseEvolutionAck } from './evolution-ack';

interface EvolutionWebhookPayload {
  event: string;
  instanceId?: string;
  instance?: string;
  data: any;
}

/**
 * Gera um resumo compacto do payload para logging.
 * Remove campos binários (jpegThumbnail, mediaKey, fileSha256, etc.)
 * que chegam como objetos de centenas de inteiros e tornam o log ilegível.
 */
function summarizePayload(payload: EvolutionWebhookPayload): string {
  try {
    const data = payload?.data ?? {};
    const msg = data?.message ?? {};
    const msgType =
      data?.messageType ||
      Object.keys(msg).find((k) => k.endsWith('Message') || k.endsWith('Audio')) ||
      'unknown';

    return JSON.stringify({
      event: payload?.event,
      instance: payload?.instance || payload?.instanceId,
      sender: data?.key?.remoteJid,
      fromMe: data?.key?.fromMe,
      messageId: data?.key?.id,
      messageType: msgType,
      pushName: data?.pushName,
      timestamp: data?.messageTimestamp,
      status: data?.status,
    });
  } catch {
    return '[erro ao resumir payload]';
  }
}

/**
 * Extrai o melhor número de telefone de dois JIDs do Evolution API.
 *
 * O WhatsApp Multi-Device pode enviar LIDs (Linked Device Identifiers) como JID
 * primário. LID NÃO é telefone — vira contato fantasma duplicado se virar `phone`.
 *
 * O tipo vem EXPLÍCITO no sufixo do JID (`@lid` vs `@s.whatsapp.net`), e é isso que
 * mandamos aqui. A heurística antiga chutava pelo COMPRIMENTO ("LID tem 14+ dígitos")
 * e era estruturalmente incapaz de acertar: LID de 13 dígitos (ex.: 4703006019620) é
 * indistinguível de um BR real (55+DDD+9 dígitos) e passava batido, duplicando o
 * paciente. O comprimento ficou só como desempate de JID sem sufixo conhecido.
 */
export function isLidJid(jid?: string): boolean {
  return (jid || '').endsWith('@lid');
}

function extractPhone(remoteJid: string, remoteJidAlt?: string): string {
  const p1 = (remoteJid || '').split('@')[0];
  const p2 = (remoteJidAlt || '').split('@')[0];

  // 1) Sufixo manda: o que NÃO é @lid é o telefone de verdade.
  const jid1EhLid = isLidJid(remoteJid);
  const jid2EhLid = isLidJid(remoteJidAlt);
  if (p1 && !jid1EhLid && jid2EhLid) return p1;
  if (p2 && !jid2EhLid && jid1EhLid) return p2;

  // 2) Sem sufixo conclusivo: cai na heurística antiga (telefone tem ≤13 dígitos).
  const looksLikePhone = (p: string) => p.length > 0 && p.length <= 13;
  if (!p2) return p1;
  if (looksLikePhone(p2) && !looksLikePhone(p1)) return p2;
  if (!looksLikePhone(p2) && looksLikePhone(p1)) return p1;
  return p2 || p1;
}

@Injectable()
export class EvolutionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EvolutionService.name);

  constructor(
    private prisma: PrismaService,
    private chatGateway: ChatGateway,
    private leadsService: LeadsService,
    private inboxesService: InboxesService,
    @InjectQueue('media-jobs') private mediaQueue: Queue,
    @InjectQueue('ai-jobs') private aiQueue: Queue,
    private whatsappService: WhatsappService,
    private moduleRef: ModuleRef,
    private adminBotService: AdminBotService,
    private mediaDownloadService: MediaDownloadService,
    private postCareService: PostCareService,
  ) {}

  /**
   * Verifica se a mensagem recebida eh resposta a uma pesquisa pos-atendimento.
   * Procura paciente com mesmo phone+tenant que tenha survey SENT recente.
   */
  private async checkPostCareResponse(tenantId: string, phone: string, text: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { tenant_id: tenantId, phone },
      select: { id: true },
    });
    if (!patient) return;
    await this.postCareService.tryCaptureResponse(tenantId, patient.id, text);
  }

  async handleMessagesUpsert(payload: EvolutionWebhookPayload) {
    const instanceName = payload?.instance || payload?.instanceId;
    this.logger.log(`[WEBHOOK] messages.upsert received from ${instanceName ?? 'unknown'}`);
    this.logger.debug(`Payload: ${summarizePayload(payload)}`);
    const dataPayload = payload?.data as any;
    const inbox = instanceName ? await this.inboxesService.findByInstanceName(instanceName) : null;
    
    if (!inbox) {
      this.logger.warn(`[WEBHOOK] No inbox found for instanceName: ${instanceName}. Message might be lost or assigned to no tenant.`);
    }

    const inboxId = inbox?.inbox_id || null;
    // Deriva tenant efetivo: prefere o da Instance, mas faz fallback para o Inbox pai.
    // Isso cobre instâncias legadas que foram criadas sem tenant_id propagado.
    const effectiveTenantId: string | null = (inbox as any)?.tenant_id || (inbox as any)?.inbox?.tenant_id || null;

    const messages = Array.isArray(dataPayload?.messages)
      ? (dataPayload.messages as any[])
      : [dataPayload];

    for (const data of messages) {
      if (!data) continue;
      const key = data.key as any;
      if (!key) continue;

      const remoteJid = key.remoteJid as string;
      const remoteJidAlt = key.remoteJidAlt as string;
      if (!remoteJid || remoteJid.includes('@g.us')) continue;

      // ─── Handle incoming reactions ───────────────────────────────
      if (data.message?.reactionMessage) {
        const reaction = data.message.reactionMessage;
        const reactionKey = reaction.key;
        const emoji = reaction.text || '';
        if (reactionKey?.id) {
          const targetMsg = await this.prisma.message.findUnique({
            where: { external_message_id: reactionKey.id },
          });
          if (targetMsg) {
            if (emoji === '') {
              await (this.prisma as any).messageReaction.deleteMany({
                where: { message_id: targetMsg.id, contact_jid: remoteJid },
              });
            } else {
              await (this.prisma as any).messageReaction.upsert({
                where: { message_id_contact_jid: { message_id: targetMsg.id, contact_jid: remoteJid } },
                update: { emoji },
                create: { message_id: targetMsg.id, contact_jid: remoteJid, emoji },
              });
            }
            const allReactions = await (this.prisma as any).messageReaction.findMany({
              where: { message_id: targetMsg.id },
            });
            this.chatGateway.emitMessageReaction(targetMsg.conversation_id, {
              messageId: targetMsg.id,
              reactions: allReactions,
            });
            // Régua de reativação: reação ADICIONADA pelo CONTATO (não a nossa, não a
            // remoção) conta como resposta. Fora do chip Financeiro. Fire-and-forget.
            const chipFinanceiro = (inbox as any)?.purpose === 'FINANCEIRO' && !!inboxId;
            if (key.fromMe !== true && emoji !== '' && !chipFinanceiro && targetMsg.conversation_id) {
              this.checkReactivationReaction(targetMsg.conversation_id, effectiveTenantId).catch(() => undefined);
            }
          }
        }
        continue;
      }

      const phone = extractPhone(remoteJid, remoteJidAlt);

      // LID (Linked Device Identifier) é identificador interno do WhatsApp, NÃO
      // telefone. Se virar `phone`, nasce um contato FANTASMA duplicado do mesmo
      // paciente (foi o caso do "VICTOR CAR" com 4703006019620 — 13 dígitos, que a
      // checagem só-por-comprimento aprovava). A versão com o telefone real
      // (@s.whatsapp.net) sempre chega num evento separado, então descartar é seguro.
      const veioDeLid = isLidJid(remoteJid) && isLidJid(remoteJidAlt || remoteJid);
      const looksLikeRealPhone = phone.length > 0 && phone.length <= 13;
      if (veioDeLid || !looksLikeRealPhone) {
        this.logger.debug(
          `[WEBHOOK] Ignorando LID ${phone} (${veioDeLid ? 'JID @lid' : `${phone.length} dígitos`}) — não é telefone real`,
        );
        continue;
      }

      // pushName from outgoing messages (fromMe=true) is the business account name, not the client.
      // Only use it as the contact name for incoming messages.
      const isFromMe = key.fromMe === true;
      const pushName = !isFromMe ? ((data.pushName as string) || null) : null;
      const messageContentCheck =
        (data.message?.conversation as string) ||
        (data.message?.extendedTextMessage?.text as string) ||
        '';

      // ── Admin Command Bot ──────────────────────────────────────────────────
      // Mensagens vindas de um admin/dentista do sistema são interceptadas aqui
      // para serem processadas como comandos CRM via IA (function calling).
      if (!isFromMe && messageContentCheck && await this.adminBotService.isEnabled()) {
        const sessionKey = `${instanceName}:${phone}`;
        if (this.adminBotService.isAdminCommand(sessionKey, messageContentCheck)) {
          const adminUser = await this.adminBotService.findAdminByPhone(phone, effectiveTenantId);
          if (adminUser && instanceName) {
            this.logger.log(`[ADMIN-BOT] Comando do admin ${phone} interceptado: "${messageContentCheck.substring(0, 60)}"`);
            await this.adminBotService.handle(
              instanceName,
              phone,
              messageContentCheck,
              adminUser.id,
              adminUser.tenant_id,
            ).catch((err) => this.logger.error(`[ADMIN-BOT] Erro ao processar comando: ${err.message}`));
            continue; // Não processar como mensagem de cliente
          }
        }
      }
      // ── Fim Admin Command Bot ──────────────────────────────────────────────
      const externalMessageId = key.id as string;
      // Onda 14.43 — Extrai texto/caption de TODOS os tipos de mensagem.
      // Antes ignorava captions de documentMessage/imageMessage/videoMessage,
      // entao mensagens com PDF anexo + texto perdiam o texto no CRM (so o
      // anexo aparecia, sem o caption). Agora preserva o caption pra ficar
      // igual ao que o paciente ve no WhatsApp.
      const messageContent =
        (data.message?.conversation as string) ||
        (data.message?.extendedTextMessage?.text as string) ||
        (data.message?.documentMessage?.caption as string) ||
        (data.message?.imageMessage?.caption as string) ||
        (data.message?.videoMessage?.caption as string) ||
        (data.message?.audioMessage?.caption as string) ||
        (data.message?.listResponseMessage?.singleSelectReply?.selectedRowId as string) ||
        (data.message?.listResponseMessage?.title as string) ||
        (data.message?.buttonsResponseMessage?.selectedDisplayText as string) ||
        '';
      const messageType = (data.messageType as string) || 'text';

      // 1. Upsert Lead (via LeadsService para garantir normalização)
      // stage não é passado: o upsert nunca sobrescreve stage em updates existentes,
      // e em creates o campo usa o default 'NOVO' definido no schema Prisma.
      const lead = await this.leadsService.upsert(
        {
          phone,
          name: pushName,
          origin: 'whatsapp',
          ...(effectiveTenantId ? { tenant: { connect: { id: effectiveTenantId } } } : {}),
        } as any,
        inboxId, // isola notificacao de lead novo ao inbox do setor
      );

      // 1a. Onda 17.64 — o CHIP classifica lead × paciente na entrada. O número da
      // CLÍNICA é privado (só quem já é paciente tem) → quem fala nele JÁ é paciente:
      // marca is_client=true (vai pra aba Clientes / time clínico, sem nutrição de
      // lead). O número COMERCIAL (Instagram) mantém o padrão de lead. Promove,
      // NUNCA rebaixa. `inbox` aqui é a Instance (findByInstanceName) → tem `purpose`.
      // `!isFromMe`: só promove quando o CONTATO realmente escreve no número da
      // clínica (número privado = já é paciente). SEM esse guard, a própria mensagem
      // do SISTEMA que sai pela Clínica (ex.: agendamento de um lead que caiu no chip
      // errado) voltava como ECO e promovia o lead a paciente — transferindo pra
      // clínica ANTES de comparecer. No modelo da clínica, o lead só vira paciente no
      // 1º atendimento (evento CONCLUÍDO), nunca por uma mensagem nossa.
      const isClinicaChip = (inbox as any)?.purpose === 'CLINICA';
      // Regra da clínica: lead que o Comercial AGENDOU só vira paciente depois de
      // comparecer ou pagar — escrever no número da Clínica (ex.: respondeu uma
      // mensagem que saiu por lá) não basta. Sem consulta marcada segue a regra do
      // número privado (paciente antigo, de antes do sistema).
      const clinicaBlocked = !isFromMe && isClinicaChip && !lead.is_client
        ? await clinicTransferBlockReason(this.prisma, lead.id).catch(() => null)
        : null;
      if (clinicaBlocked) {
        this.logger.log(`[WEBHOOK] Lead ${lead.id} (${phone}) escreveu no chip CLINICA mas segue LEAD: agendado sem comparecimento/pagamento`);
      }
      if (!isFromMe && isClinicaChip && !lead.is_client && !clinicaBlocked) {
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { is_client: true, became_client_at: (lead as any).became_client_at ?? new Date() },
        });
        (lead as any).is_client = true;
        this.logger.log(`[WEBHOOK] Lead ${lead.id} (${phone}) via chip CLINICA (msg do contato) → paciente (is_client=true)`);
      }

      // Onda 18.32 — ISOLAMENTO do chip FINANCEIRO: contato de cobrança tem conversa
      // PRÓPRIA (o "contato duplicado" é intencional: uma conversa no mundo Comercial/
      // Clínica + uma no Financeiro). Msg chegando no chip Financeiro acha/cria SÓ a
      // conversa do inbox FINANCEIRO; nos outros chips a busca NUNCA pega a conversa
      // do Financeiro — senão a resposta de cobrança sequestrava a conversa principal
      // (e vice-versa). Sem inboxId (chip financeiro sem inbox, não deveria ocorrer),
      // cai no comportamento normal pra não perder mensagem.
      const isFinanceiroChip = (inbox as any)?.purpose === 'FINANCEIRO' && !!inboxId;
      const convScope: any = isFinanceiroChip
        ? { inbox: { purpose: 'FINANCEIRO' } }
        : { NOT: { inbox: { purpose: 'FINANCEIRO' } } };

      // 1b. Lead PERDIDO/FINALIZADO voltou a falar → reativar para QUALIFICANDO.
      // SÓ pra chip comercial/legado: paciente da clínica não é "lead dormente
      // reativado", e resposta de COBRANÇA (chip financeiro) também não ressuscita lead.
      if (!isFromMe && !isClinicaChip && !isFinanceiroChip && ['PERDIDO', 'FINALIZADO'].includes(lead.stage)) {
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: {
            stage: 'QUALIFICANDO',
            stage_entered_at: new Date(),
            loss_reason: null,
          },
        });
        (lead as any).stage = 'QUALIFICANDO';
        this.logger.log(`[REACTIVATE] Lead ${lead.id} (${phone}) voltou a falar — stage ${lead.stage} → QUALIFICANDO`);
      }

      // 2. Find or Create Conversation
      // Onda 17.64 (Model B) — UMA conversa por LEAD: acha SEM filtrar por instance_name.
      // O mesmo contato falando nos 2 números (Comercial/Clínica) usa a MESMA conversa, em
      // vez de duplicar. O SETOR (inbox) controla o número de saída (resolveDispatchInstance);
      // instance_name vira só rastreio/fallback. Consistente com os outros handlers (resync,
      // contacts.update) que JÁ acham a conversa por lead.
      let conv = await this.prisma.conversation.findFirst({
        where: {
          lead_id: lead.id,
          channel: 'whatsapp',
          status: 'ABERTO',
          ...convScope, // Onda 18.32 — financeiro só acha financeiro; resto nunca acha financeiro
        },
        orderBy: { last_message_at: 'desc' },
      });
      if (!conv) {
        // 1) Tentar reabrir conversa FECHADO
        const closedConv = await this.prisma.conversation.findFirst({
          where: { lead_id: lead.id, channel: 'whatsapp', status: 'FECHADO', ...convScope },
          orderBy: { last_message_at: 'desc' },
        });
        if (closedConv) {
          conv = await this.prisma.conversation.update({
            where: { id: closedConv.id },
            data: {
              status: 'ABERTO',
              last_message_at: new Date(),
              assigned_user_id: null, // Reset para reatribuição via round-robin
              ...(inboxId && !closedConv.inbox_id ? { inbox_id: inboxId } : {}),
            },
          });
          this.logger.log(`[REOPEN] Conversa ${conv.id} reaberta para lead ${lead.id} (operador resetado)`);
        }
        // 2) Se não achou FECHADO, checar ADIADO — mantém status, só atualiza timestamp
        if (!conv) {
          const adiadoConv = await this.prisma.conversation.findFirst({
            where: { lead_id: lead.id, channel: 'whatsapp', status: 'ADIADO', ...convScope },
            orderBy: { last_message_at: 'desc' },
          });
          if (adiadoConv) {
            conv = await this.prisma.conversation.update({
              where: { id: adiadoConv.id },
              data: { last_message_at: new Date() },
            });
            this.logger.log(`[ADIADO] Conversa ${conv.id} recebeu msg mas permanece ADIADO`);
          }
        }
        // 3) Se não encontrou nenhuma, criar nova. O índice único parcial
        //    (lead_id, inbox_id) WHERE status<>'ENCERRADO' recusa a 2ª conversa numa
        //    CORRIDA (dois webhooks quase juntos do mesmo lead+inbox). Em vez de
        //    duplicar (ou quebrar o webhook), o PERDEDOR da corrida (P2002) REUSA a
        //    conversa que o outro acabou de criar. É o fim do "2 conversas same-instance".
        if (!conv) {
          try {
            conv = await this.prisma.conversation.create({
              data: {
                lead_id: lead.id,
                channel: 'whatsapp',
                status: 'ABERTO',
                external_id: `${phone}@s.whatsapp.net`,
                inbox_id: inboxId,
                instance_name: instanceName,
                tenant_id: effectiveTenantId || lead.tenant_id,
              },
            });
          } catch (e: any) {
            if (e?.code !== 'P2002') throw e;
            conv = await this.prisma.conversation.findFirst({
              where: { lead_id: lead.id, channel: 'whatsapp', status: { not: 'ENCERRADO' }, ...convScope },
              orderBy: { last_message_at: 'desc' },
            });
            if (!conv) throw e;
            this.logger.log(`[DEDUP] Corrida na criação de conversa (lead ${lead.id}) — reusando ${conv.id}`);
          }
        }
      } else if ((!conv.inbox_id && inboxId) || (!conv.tenant_id && effectiveTenantId)) {
        // Conversa existe mas está sem inbox_id ou sem tenant_id — backfill a partir
        // da instância/inbox. Sem isso, conversas antigas (criadas antes do vínculo
        // instância-setor) ficam invisíveis no filtro `/conversations` que sempre
        // aplica where.tenant_id = user.tenant_id.
        const updateData: any = { instance_name: instanceName };
        if (!conv.inbox_id && inboxId) updateData.inbox_id = inboxId;
        if (!conv.tenant_id && effectiveTenantId) updateData.tenant_id = effectiveTenantId;
        conv = await this.prisma.conversation.update({
          where: { id: conv.id },
          data: updateData,
        });
      }

      // 2b. Conversa presa num chip MORTO (ex.: o antigo "whatsapp", que não existe mais
      // na Evolution — toda resposta da IA, follow-up e aviso do Financeiro por ela dava
      // 404 calado). O paciente falou por um chip VIVO e com função → a conversa passa a
      // usar este. Só troca quando o chip atual é inválido (sem linha Instance da clínica
      // com função): um chip vivo Comercial/Clínica é mantido (Model B — a conversa flutua
      // entre os dois). O mundo é o mesmo: o convScope acima já garante Financeiro só com
      // Financeiro. Clínica legada de 1 chip (sem função) não entra (purpose obrigatório).
      if (conv && instanceName && conv.instance_name !== instanceName && (inbox as any)?.purpose) {
        const atualVivo = conv.instance_name
          ? await this.prisma.instance.findFirst({
              where: {
                name: conv.instance_name,
                purpose: { not: null },
                ...((conv.tenant_id || effectiveTenantId) ? { tenant_id: conv.tenant_id || effectiveTenantId } : {}),
              },
              select: { id: true },
            })
          : null;
        if (!atualVivo) {
          const antigo = conv.instance_name;
          conv = await this.prisma.conversation.update({
            where: { id: conv.id },
            data: { instance_name: instanceName },
          });
          this.logger.log(`[WEBHOOK] Conversa ${conv.id} estava no chip "${antigo ?? '—'}" (inválido) → ${instanceName}`);
        }
      }

      // 2a. Onda 17.64 — o SETOR da conversa (que controla o NÚMERO de saída via
      // resolveDispatchInstance) é definido na CRIAÇÃO (inbox do chip que recebeu) e
      // mudado APENAS pelo operador no botão "Mover setor". NÃO realinhamos por inbound:
      // senão uma mensagem do paciente no número da clínica desfazia silenciosamente um
      // "Mover → Comercial" manual — a escolha do operador tem que mandar. A aba
      // Leads/Clientes segue o chip (is_client) no bloco 1a, independente do setor.

      // ── Auto-merge de conversa LID ─────────────────────────────────────────
      // Se o remoteJid era um LID e conseguimos o telefone real via remoteJidAlt,
      // mescla a conversa "gêmea" do LID na do telefone real e encerra a do LID.
      // É ESTE bloco que cura os contatos fantasma já criados — e ele estava inerte
      // pela mesma heurística de comprimento do bug (LID de 13 dígitos nunca casava
      // em `> 13`). Agora vai pelo sufixo do JID, igual ao resto do arquivo.
      const rawLidPhone = remoteJid.split('@')[0];
      if (isLidJid(remoteJid) && phone !== rawLidPhone) {
        // Onda 17.36 — merge LID restrito ao mesmo tenant do lead resolvido
        const lidLead = await this.prisma.lead.findFirst({
          where: { phone: rawLidPhone, tenant_id: lead.tenant_id },
        });
        if (lidLead && lidLead.id !== lead.id) {
          const lidConvs = await this.prisma.conversation.findMany({
            where: { lead_id: lidLead.id, channel: 'whatsapp' },
          });
          for (const lidConv of lidConvs) {
            // Move todas as mensagens da conversa LID → conversa do telefone real
            await this.prisma.message.updateMany({
              where: { conversation_id: lidConv.id },
              data: { conversation_id: conv.id },
            });
            // Fecha a conversa LID duplicada
            await this.prisma.conversation.update({
              where: { id: lidConv.id },
              data: { status: 'FECHADO' },
            });
            this.logger.log(
              `[AUTO-MERGE] Conv LID ${lidConv.id} (${rawLidPhone}) → conv telefone ${conv.id} (${phone}) — ${lidConvs.length} conv(s) mescladas`,
            );
          }
          // Notifica a inbox para atualizar (remove duplicata da tela)
          this.chatGateway.emitConversationsUpdate(conv.tenant_id ?? null, true);
        }
      }
      // ──────────────────────────────────────────────────────────────────────

      // Auto-assign via round-robin — apenas entre operadores ONLINE
      // Se ninguém online: IA atende sozinha (ai_mode permanece true, sem assigned_user_id)
      // Quando o primeiro operador ficar online, as conversas pendentes serão atribuídas
      // automaticamente via ChatGateway.assignPendingConversations()
      if (!conv.assigned_user_id) {
        const onlineUserIds = this.chatGateway.getOnlineUserIds();
        const nextUserId: string | null = inboxId
          ? await this.inboxesService.getNextAssignee(inboxId, onlineUserIds)
          : null;

        if (nextUserId) {
          conv = await this.prisma.conversation.update({
            where: { id: conv.id },
            data: { assigned_user_id: nextUserId },
            // ai_mode NÃO é alterado: operador monitora, IA continua respondendo
          });
          this.logger.log(`[AUTO-ASSIGN] Conversa ${conv.id} → operador online ${nextUserId}`);
        } else {
          // Ninguém online → IA atende sozinha (ai_mode já é true por default)
          this.logger.log(`[AUTO-ASSIGN] Nenhum operador online — IA atende conversa ${conv.id}`);
        }
      }

      // 3. Insert Message (idempotent)
      const existingMsg = await this.prisma.message.findUnique({
        where: { external_message_id: externalMessageId },
        include: { media: true, skill: { select: { id: true, name: true, area: true } } },
      });
      if (existingMsg) {
        this.logger.log(`[DEDUP] Mensagem já existe: ${externalMessageId} — re-emitindo WebSocket como fallback`);
        // Re-emite WebSocket para cobrir o caso em que o BullMQ QueueEvents perdeu o evento
        // (mensagem já está no banco mas o frontend pode não ter sido notificado em tempo real)
        this.chatGateway.emitNewMessage(existingMsg.conversation_id, existingMsg);
        this.chatGateway.emitConversationsUpdate(conv.tenant_id ?? null, true);
        continue;
      }

      // Para mensagens enviadas (fromMe=true / send.message echo), verifica se existe uma
      // mensagem "pendente" na mesma conversa com o mesmo texto salva em menos de 2 minutos.
      // Isso ocorre quando o CRM/worker salva a mensagem com external_message_id OTIMISTA
      // (sintético) no momento do envio, e depois chega o eco do WhatsApp com o id real.
      // Sem reconciliar, viram DUAS linhas pra UM envio (paciente recebe 1, CRM mostra 2).
      // Prefixos sintéticos: 'out_' (CRM manda), 'sys_reminder_*'/'sys_cobranca_*' (crons/
      // lembretes/cobrança). ANTES só casava 'out_' → lembrete e cobrança duplicavam a bolha.
      // Agora casa QUALQUER otimista (out_ OU sys_) e atualiza o id em vez de duplicar.
      if (isFromMe && messageContent) {
        // Janela de 10 min (era 2): quando o Evolution responde ERRO mas ENTREGA, o
        // eco pode demorar; sem reconciliar a tempo, o operador vê "erro" (vermelho) e
        // REENVIA → paciente recebe 2×. 10 min dá folga pro eco casar o otimista
        // (out_/sys_) e marcar "enviado" antes do reenvio.
        const since = new Date(Date.now() - 10 * 60 * 1000);
        const pendingMsg = await this.prisma.message.findFirst({
          where: {
            conversation_id: conv.id,
            direction: 'out',
            text: messageContent,
            created_at: { gte: since },
            OR: [
              { external_message_id: { startsWith: 'out_' } },
              { external_message_id: { startsWith: 'sys_' } },
            ],
          },
          include: { media: true, skill: { select: { id: true, name: true, area: true } } },
        });
        if (pendingMsg) {
          const updated = await this.prisma.message.update({
            where: { id: pendingMsg.id },
            data: { external_message_id: externalMessageId, status: 'enviado' },
            include: { media: true, skill: { select: { id: true, name: true, area: true } } },
          });
          this.chatGateway.emitMessageUpdate(conv.id, updated);
          this.logger.log(`[DEDUP] Msg pendente ${pendingMsg.id} vinculada ao ID real ${externalMessageId}`);
          continue;
        }
      }

      let msgType = 'text';
      if (
        [
          'imageMessage',
          'audioMessage',
          'documentMessage',
          'videoMessage',
          'stickerMessage',
        ].includes(messageType)
      ) {
        msgType = messageType.replace('Message', '');
      }

      // Extract quoted/reply context from contextInfo (works for both conversation and extendedTextMessage)
      const contextInfo =
        (data.message?.extendedTextMessage?.contextInfo as any) ||
        (data.message?.conversation ? undefined : undefined) ||
        (data.message?.[messageType]?.contextInfo as any);
      const quotedStanzaId: string | undefined = contextInfo?.stanzaId;
      const quotedText: string | undefined =
        contextInfo?.quotedMessage?.conversation ||
        contextInfo?.quotedMessage?.extendedTextMessage?.text ||
        contextInfo?.quotedMessage?.imageMessage?.caption;

      let replyToId: string | null = null;
      let replyToText: string | null = quotedText || null;
      if (quotedStanzaId) {
        const quotedMsg = await this.prisma.message.findUnique({
          where: { external_message_id: quotedStanzaId },
        });
        replyToId = quotedMsg?.id || null;
        if (!replyToText && quotedMsg?.text) replyToText = quotedMsg.text;
      }

      const isOutgoing = isFromMe;
      let msg;
      try {
        msg = await this.prisma.message.create({
          data: {
            conversation_id: conv.id,
            direction: isOutgoing ? 'out' : 'in',
            type: msgType,
            text: messageContent,
            external_message_id: externalMessageId,
            status: isOutgoing ? 'enviado' : 'recebido',
            reply_to_id: replyToId,
            reply_to_text: replyToText,
            // Model B: grava o chip que de fato recebeu/enviou esta msg. A conversa
            // pode flutuar entre Comercial/Clinica, mas o retry de download de midia
            // precisa bater na instancia certa (a que tem a msg na Evolution).
            instance_name: instanceName,
          },
        });
      } catch (e: any) {
        // Corrida no external_message_id @unique GLOBAL: a OUTRA ponta (ex.: o cron
        // de cobrança do Financeiro, que grava o echo do próprio envio) já inseriu
        // esta mensagem. Não é erro — pula SÓ esta e segue o lote. Sem o guard, um
        // P2002 aqui abortava as DEMAIS mensagens do mesmo payload (perda de inbound).
        if (e?.code === 'P2002') {
          this.logger.warn(`[WEBHOOK] external_message_id ${externalMessageId} já existe (corrida) — pulando esta mensagem.`);
          continue;
        }
        throw e;
      }

      // Update Convo last message
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { last_message_at: new Date() },
      });

      // ─── 4. Emit newMessage IMEDIATAMENTE (frontend vê a mensagem já) ───
      // Para mídia: emite sem media record, frontend mostra "Baixando..." por 10s
      // depois botão "Recarregar" se ainda não chegou.
      this.chatGateway.emitNewMessage(conv.id, msg);

      // ─── 5. Download de mídia em background (mesmo processo, não-await) ──
      // MediaDownloadService faz retry interno (3x com backoff 2s/5s/10s)
      // e emite messageUpdate ao final (sucesso ou falha final).
      // Sem worker BullMQ — fluxo simplificado estilo Chatwoot.
      if (msgType !== 'text') {
        const mediaData = (data.message as any)?.[messageType];
        const download = this.mediaDownloadService.downloadAndStore({
          messageId: msg.id,
          conversationId: conv.id,
          externalMessageId,
          instanceName,
          mediaData,
        });
        download.catch(err => {
          this.logger.error(`[MEDIA-SYNC] Erro inesperado para msg ${msg.id}: ${err.message}`);
        });
        // Triagem NÃO-PACIENTE: currículo/proposta que a pessoa manda DEPOIS da triagem
        // da IA vai pros ADMs. Best-effort, fire-and-forget: nunca atrasa nem quebra o webhook.
        if (!isOutgoing && (msgType === 'document' || msgType === 'image')) {
          this.forwardNonPatientAttachment(download, {
            messageId: msg.id,
            messageCreatedAt: msg.created_at,
            leadId: lead.id,
            tenantId: conv.tenant_id ?? lead.tenant_id ?? effectiveTenantId ?? null,
            msgType,
            caption: messageContent,
            fileNameHint: (mediaData as any)?.fileName ?? null,
            instanceName: instanceName || conv.instance_name || null,
          }).catch((e) => this.logger.warn(`[NAO-PACIENTE][ANEXO] msg ${msg.id}: ${e?.message}`));
        }
      }
      this.chatGateway.emitConversationsUpdate(conv.tenant_id ?? null, true);

      // Notify operator(s) about incoming message (sound + unread badge)
      if (!isOutgoing) {
        this.chatGateway.emitIncomingMessageNotification(
          conv.tenant_id ?? null,
          conv.inbox_id ?? null,
          conv.assigned_user_id || null,
          { conversationId: conv.id, contactName: lead.name || lead.phone },
          (conv as any).assigned_dentist_id || null,
          lead.is_client,
        );

        // ─── Régua de reativação: o contato respondeu → para a régua dele ───
        // Fora do filtro de tamanho (áudio/imagem/"ok" também são resposta) e NUNCA
        // pelo chip Financeiro (resposta de cobrança não é resposta à reativação).
        // Fire-and-forget com catch: jamais pode atrasar/quebrar o recebimento.
        if (!isFinanceiroChip) {
          this.checkReactivationResponse(lead.id, lead.tenant_id ?? effectiveTenantId ?? null, messageContent, {
            phone: lead.phone,
          }).catch((e) =>
            this.logger.warn(`[REGUA-REATIV] falha ao parar a régua do lead ${lead.id}: ${e?.message}`),
          );
        }

        // ─── Response Listener: verifica se é resposta a um follow-up ─────
        if (messageContent && messageContent.length >= 3) {
          this.checkFollowupResponse(lead.id, messageContent).catch(e =>
            this.logger.warn(`[FOLLOWUP-LISTENER] ${e.message}`),
          );
          // Pos-atendimento: paciente respondeu? captura sentiment + escala se NEGATIVE
          if (lead.tenant_id && lead.phone) {
            this.checkPostCareResponse(lead.tenant_id, lead.phone, messageContent).catch(e =>
              this.logger.warn(`[POST-CARE-LISTENER] ${e.message}`),
            );
          }
        }
      }

      // 5. Se AI_Mode ativo e mensagem recebida (não enviada), agenda job para a IA responder
      // Debounce: cancela job pendente e cria novo com timer resetado, acumulando mensagens
      // rápidas. Quando o lead para de digitar, o job dispara e a IA responde tudo de uma vez.
      //
      // Kill switch global (WHATSAPP_AI_ENABLED): quando false, NÃO enfileira resposta —
      // usado pelo admin ao cadastrar instância nova sem querer que a IA responda ainda.
      this.logger.debug(`[AI-CHECK] conv=${conv.id} ai_mode=${conv.ai_mode} isOutgoing=${isOutgoing}`);
      if (!isOutgoing && conv.ai_mode) {
        // Onda 18.21 — liberação de IA 100% POR CHIP. Cada chip tem seu on/off
        // (AI_ENABLED_<PURPOSE>). Migração suave: se o flag do chip ainda não foi
        // setado, HERDA o global antigo (WHATSAPP_AI_ENABLED) — assim quem tinha a
        // IA desligada continua desligada até ligar chip a chip. Instância sem
        // purpose usa o global (não some do radar).
        const killSwitch = await this.prisma.globalSetting.findUnique({
          where: { key: 'WHATSAPP_AI_ENABLED' },
        });
        const master = (killSwitch?.value ?? 'true') !== 'false';
        let aiEnabled = master;
        let chipPurpose: string | null = null;
        // Liga/desliga e tempo de resposta são POR CLÍNICA (perfil da IA em
        // Ajustes › IA): a clínica é a da conversa — nunca mistura clínicas.
        let convTenantId: string | null = conv.tenant_id ?? effectiveTenantId ?? lead.tenant_id ?? null;
        if (instanceName) {
          const inst = await this.prisma.instance.findFirst({
            where: { name: instanceName },
            select: { purpose: true, tenant_id: true },
          });
          chipPurpose = inst?.purpose || null;
          // Conversa/inbox/lead legados sem clínica: o dono do chip decide.
          convTenantId = conv.tenant_id ?? effectiveTenantId ?? inst?.tenant_id ?? lead.tenant_id ?? null;
          if (chipPurpose) {
            // 1º a chave DA CLÍNICA (TenantSetting AI_ENABLED_<P>); sem ela, regra
            // antiga (GlobalSetting AI_ENABLED_<P>, senão o kill switch). Mesma regra
            // de SettingsService.getChipAiEnabledMap (toggles da tela).
            const tenantFlag =
              convTenantId && isAiChipPurpose(chipPurpose)
                ? await this.prisma.tenantSetting
                    .findUnique({
                      where: { tenant_id_key: { tenant_id: convTenantId, key: aiEnabledKey(chipPurpose) } },
                      select: { value: true },
                    })
                    .catch(() => null)
                : null;
            if (tenantFlag) {
              aiEnabled = tenantFlag.value !== 'false';
            } else {
              const flag = await this.prisma.globalSetting.findUnique({
                where: { key: `AI_ENABLED_${chipPurpose}` },
              });
              aiEnabled = flag?.value != null ? flag.value !== 'false' : master;
            }
          }
        }
        if (!aiEnabled) {
          this.logger.log(
            `[AI] IA desativada (chip ${chipPurpose ?? 'sem purpose'}) — ignorando conv ${conv.id}`,
          );
        } else {
        try {
          // Tempo de resposta (debounce) do CHIP na clínica: perfil da IA
          // (TenantSetting AI_PROFILE_<P>.responseDelaySec). null = padrão global
          // (GlobalSetting AI_COOLDOWN_SECONDS, padrão 8s) — regra antiga.
          // Chip sem função (legado, 1 chip só) usa o perfil COMERCIAL — mesma regra do worker.
          let profileDelaySec: number | null = null;
          const profilePurpose = isAiChipPurpose(chipPurpose) ? chipPurpose : 'COMERCIAL';
          if (convTenantId) {
            const profRow = await this.prisma.tenantSetting
              .findUnique({
                where: { tenant_id_key: { tenant_id: convTenantId, key: aiProfileKey(profilePurpose) } },
                select: { value: true },
              })
              .catch(() => null);
            profileDelaySec = normalizeAiChipProfile(profRow?.value ?? null).responseDelaySec;
          }
          let debounceMs: number;
          if (profileDelaySec !== null) {
            debounceMs = profileDelaySec * 1000;
          } else {
            const cooldownRaw = await this.prisma.globalSetting.findUnique({
              where: { key: 'AI_COOLDOWN_SECONDS' },
            });
            const cooldownSeconds = cooldownRaw?.value ? parseInt(cooldownRaw.value, 10) : 8;
            debounceMs = (isNaN(cooldownSeconds) ? 8 : Math.max(0, cooldownSeconds)) * 1000;
          }
          const jobId = `ai-debounce-${conv.id}`;

          if (debounceMs > 0) {
            let useFixedId = true;
            const existing = await this.aiQueue.getJob(jobId);
            if (existing) {
              try {
                await existing.remove();
                this.logger.log(`[AI] Debounce: job ${jobId} removido, timer resetado`);
              } catch {
                useFixedId = false;
                this.logger.warn(
                  `[AI] Debounce: job ${jobId} ativo/bloqueado — novo job agendado sem ID fixo`,
                );
              }
            }

            await this.aiQueue.add(
              'process_ai_response',
              { conversation_id: conv.id, lead_id: lead.id },
              useFixedId
                ? { jobId, delay: debounceMs, removeOnComplete: true, removeOnFail: false }
                : { delay: debounceMs, removeOnComplete: true, removeOnFail: false },
            );
            this.logger.log(`[AI] Job enfileirado: ${useFixedId ? jobId : '(sem ID fixo)'} delay=${debounceMs}ms`);
          } else {
            await this.aiQueue.add('process_ai_response', {
              conversation_id: conv.id,
              lead_id: lead.id,
            });
            this.logger.log(`[AI] Job enfileirado imediato para conv ${conv.id}`);
          }
        } catch (queueErr: any) {
          this.logger.error(`[AI] ERRO ao enfileirar job de IA: ${queueErr.message}`);
        }
        }
      }

      // 5b. Conversa do operador humano (ai_mode=false): enfileira job apenas para
      // atualizar a Long Memory. O worker detecta ai_mode=false e só extrai fatos,
      // sem gerar resposta IA. Debounce de 15s para acumular mensagens rápidas.
      if (!isOutgoing && !conv.ai_mode) {
        const memJobId = `memory-debounce-${conv.id}`;
        const existing = await this.aiQueue.getJob(memJobId);
        if (existing) {
          try {
            await existing.remove();
          } catch {
            // Job ativo — será processado; a próxima mensagem pega no próximo ciclo
          }
        }
        await this.aiQueue.add(
          'process_ai_response',
          { conversation_id: conv.id, lead_id: lead.id },
          { jobId: memJobId, delay: 15_000, removeOnComplete: true, removeOnFail: false },
        );
      }
    }
  }

  // ─── Régua de reativação de leads: parar na 1ª resposta + opt-out ─────────
  //
  // Prisma DIRETO (sem injetar serviço novo — ciclo de DI já derrubou a API) e
  // best-effort: qualquer erro só loga. A fonte da verdade continua sendo o
  // despachante do worker, que re-checa "o lead escreveu?" antes de cada envio
  // (o webhook pode falhar num deploy). Aqui é o freio IMEDIATO.
  //
  // Só age se existir ciclo ATIVA ou toque ENVIADO recente (consulta barata).
  //
  // O NÚMERO é a identidade, não o lead_id: o mesmo telefone pode estar em 2+ leads
  // da clínica (gêmeos 12×13 dígitos que o merge não fundiu). Resposta em qualquer
  // um para a régua de TODOS — senão o gêmeo seguia mandando toque depois da
  // resposta, pelo mesmo chip, pra mesma pessoa.
  //
  // Opt-out por texto ("pare", "sem interesse"…) é PERMANENTE e não tem tela pra
  // desfazer, então só vale quando é a 1ª resposta a um toque que de fato SAIU
  // (ENVIADO ou ENVIANDO, sem replied_at) e a mensagem inteira é o pedido (regex
  // ESTRITA do shared). "Cancelar a consulta de amanhã" dias depois de já ter
  // respondido, um "pare" com o ciclo só em prévia (Envio desligado) ou recusa só
  // pela regra ampla encerram como RESPONDEU. Reação (👍/❤️) nunca é opt-out.
  private static readonly REATIV_RESPOSTA_JANELA_MS = 14 * 86400000;

  // ─── Triagem não-paciente: arquivo que chega DEPOIS → ADMs ────────────────
  //
  // A IA (worker) marca Lead.non_patient_category/non_patient_at quando o contato é
  // fornecedor / currículo / parceria / negócio / spam, pausa a IA e avisa os ADMs.
  // Se a pessoa manda o currículo/proposta DEPOIS (até 72h), este encaminha o arquivo
  // pros números de aviso da Central (os do Venda feita / Resumo diário) + os ADMs com
  // o aviso marcado no cadastro da equipe (loadAdminAlertRecipients), pelo chip
  // FINANCEIRO → CLINICA → resto. Toggle: o mesmo da triagem
  // (NAO_PACIENTE_TRIAGE_ENABLED_<t>). Prisma direto + FileStorage pego pelo ModuleRef (sem injetar nada novo no construtor — ciclo de DI já derrubou a API).
  // Dedup por mensagem: AuditLog NAO_PACIENTE_ANEXO (entity_id = Message.id).
  private static readonly NAO_PACIENTE_ANEXO_MAX_BYTES = 15 * 1024 * 1024;

  private async forwardNonPatientAttachment(
    download: Promise<boolean>,
    ctx: {
      messageId: string;
      messageCreatedAt: Date;
      leadId: string;
      tenantId: string | null;
      msgType: string;
      caption: string | null;
      fileNameHint: string | null;
      /** Chip por onde o arquivo CHEGOU (mesma trava de função da triagem). */
      instanceName: string | null;
    },
  ): Promise<void> {
    const tenantId = ctx.tenantId;
    if (!tenantId) return;

    // 1) Barato primeiro: o contato foi triado como não-paciente nas últimas 72h e a
    //    mensagem é POSTERIOR à triagem? (o arquivo que veio junto da 1ª mensagem a
    //    IA já leva no próprio aviso).
    const lead = await this.prisma.lead.findUnique({
      where: { id: ctx.leadId },
      select: { name: true, phone: true, is_client: true, non_patient_category: true, non_patient_at: true },
    });
    if (!lead?.non_patient_category || !lead.non_patient_at) return;
    // Paciente NUNCA tem arquivo encaminhado aos ADMs (raio-x, documento...): triagem
    // errada que depois virou paciente (is_client / cadastro de Paciente) para aqui.
    if (lead.is_client) return;
    const triadoEm = new Date(lead.non_patient_at).getTime();
    const chegouEm = new Date(ctx.messageCreatedAt).getTime();
    if (chegouEm <= triadoEm) return;
    if (Date.now() - triadoEm > NAO_PACIENTE_ANEXO_JANELA_MS) return;

    // Mesma trava de função da triagem (ai.processor): só chip COMERCIAL ou sem função.
    // Arquivo que chega pelo chip da CLÍNICA/FINANCEIRO é de paciente — nunca encaminha.
    if (ctx.instanceName) {
      const chip = await this.prisma.instance.findFirst({
        where: { name: ctx.instanceName },
        select: { purpose: true },
      });
      if (chip?.purpose === 'CLINICA' || chip?.purpose === 'FINANCEIRO') return;
    }
    const paciente = await this.prisma.patient.findFirst({
      where: { lead_id: ctx.leadId },
      select: { id: true },
    });
    if (paciente) return;

    const toggle = await this.prisma.globalSetting.findUnique({ where: { key: naoPacienteTriageKey(tenantId) } });
    if (toggle?.value !== 'true') return;

    // Quem recebe: números da Central + ADMs com "Contato não-paciente" ligado no
    // cadastro da equipe, menos quem desligou (regra única do @crm/shared).
    const destinos = await loadAdminAlertRecipients(this.prisma, tenantId, 'nao_paciente_triage');
    if (!destinos.length) {
      this.logger.warn(`[NAO-PACIENTE][ANEXO] tenant ${tenantId}: sem destinatário (Central/ADMs) — arquivo da msg ${ctx.messageId} não encaminhado.`);
      return;
    }

    // 2) Dedup por mensagem (marca ANTES de enviar: na dúvida, não manda 2×).
    const ja = await this.prisma.auditLog.findFirst({
      where: { entity: 'NAO_PACIENTE_ANEXO', entity_id: ctx.messageId },
      select: { id: true },
    });
    if (ja) return;
    await this.prisma.auditLog.create({
      data: { entity: 'NAO_PACIENTE_ANEXO', entity_id: ctx.messageId, action: 'forward', meta_json: { tenant_id: tenantId } },
    });

    // 3) Espera o download da mídia (MediaDownloadService grava no filesystem da API).
    const baixou = await download.catch(() => false);
    let base64: string | null = null;
    let mimetype: string | null = null;
    let fileName: string | null = null;
    if (baixou) {
      const media = await this.prisma.media.findUnique({
        where: { message_id: ctx.messageId },
        select: { file_path: true, mime_type: true, original_name: true, size: true },
      });
      if (media?.file_path && (media.size ?? 0) <= EvolutionService.NAO_PACIENTE_ANEXO_MAX_BYTES) {
        try {
          const storage = this.moduleRef.get(FileStorageService, { strict: false });
          const buf = await storage.read(media.file_path);
          base64 = buf.toString('base64');
          mimetype = (media.mime_type || '').split(';')[0].trim() || null;
          const ext = (mimetype?.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
          fileName = media.original_name || ctx.fileNameHint || `arquivo.${ext}`;
        } catch (e: any) {
          this.logger.warn(`[NAO-PACIENTE][ANEXO] não leu o arquivo da msg ${ctx.messageId}: ${e?.message}`);
        }
      }
    }

    const nome = lead.name || lead.phone || 'Contato';
    const legenda =
      `📎 Arquivo de ${nome} (${nonPatientCategoryLabel(lead.non_patient_category)})` +
      (lead.phone ? `\nTel: ${lead.phone}` : '') +
      (ctx.caption ? `\nMensagem: "${String(ctx.caption).slice(0, 300)}"` : '');

    // 4) Chips da clínica: FINANCEIRO → CLINICA → resto (mesma ordem do aviso interno).
    const chips = await this.prisma.instance.findMany({
      where: { tenant_id: tenantId, type: 'whatsapp' },
      select: { name: true, purpose: true },
    });
    const rank = (pp?: string | null) => (pp === 'FINANCEIRO' ? 0 : pp === 'CLINICA' ? 1 : 2);
    const ordem = chips.sort((a, b) => rank(a.purpose) - rank(b.purpose) || a.name.localeCompare(b.name)).map((c) => c.name);
    const entregou = (r: any) =>
      !!r && typeof r === 'object' && !(typeof r.statusCode === 'number' && r.statusCode >= 400) &&
      !(r.error && !r.key) && r.exists !== false && !!(r.key?.id || r.messageId || r.id);

    for (const { phone, userId } of destinos) {
      let ok: any = null;
      let erro = 'nenhum chip entregou';
      if (base64) {
        for (const chip of ordem) {
          const r = await this.whatsappService
            .sendMedia(phone, ctx.msgType === 'image' ? 'image' : 'document', base64, legenda, chip, fileName || undefined, mimetype || undefined)
            .catch((e: any) => ({ statusCode: 500, error: e?.message }));
          if (entregou(r)) { ok = r; break; }
          erro = `arquivo: ${String((r as any)?.error || (r as any)?.statusCode || 'falhou').slice(0, 160)}`;
        }
      }
      if (!ok) {
        // Sem arquivo (não baixou / grande demais / nenhum chip entregou): avisa em texto.
        const texto = `${legenda}\n\n_(o arquivo não pôde ser anexado — veja na conversa pelo painel)_`;
        for (const chip of ordem) {
          const r = await this.whatsappService.sendText(phone, texto, chip, undefined, tenantId).catch(() => null);
          if (entregou(r)) { ok = r; break; }
        }
      }
      await this.prisma.dispatchLog
        .create({
          data: {
            tenant_id: tenantId,
            type: 'nao_paciente_anexo',
            channel: 'WHATSAPP',
            recipient_name: nome.slice(0, 200),
            recipient_phone: phone,
            status: ok ? 'SENT' : 'FAILED',
            error: ok ? null : erro.slice(0, 500),
            external_message_id: ok?.key?.id || null,
            ref_user_id: userId,
          },
        })
        .catch(() => undefined);
      if (ok) this.logger.log(`[NAO-PACIENTE][ANEXO] tenant ${tenantId}: arquivo de ${nome} encaminhado pra ${phone}.`);
      else this.logger.warn(`[NAO-PACIENTE][ANEXO] tenant ${tenantId}: arquivo de ${nome} NÃO entregue pra ${phone} (${erro}).`);
    }
  }

  private async checkReactivationResponse(
    leadId: string,
    tenantId: string | null,
    text: string,
    opts: { phone?: string | null; reacao?: boolean } = {},
  ): Promise<void> {
    try {
      if (!tenantId) return; // a régua só existe com clínica — lead órfão nunca entrou
      const now = new Date();

      // Variantes do número (com/sem 9, com/sem 55) — helper ÚNICO do shared.
      let phone = opts.phone ?? null;
      if (!phone) {
        const l = await this.prisma.lead.findFirst({
          where: { id: leadId, tenant_id: tenantId },
          select: { phone: true },
        });
        phone = l?.phone ?? null;
      }
      const variantes = brazilPhoneMatchVariants(phone);
      // Filtro "este lead OU qualquer lead da clínica com o mesmo número" — via
      // relação, pra o caminho comum (sem régua) continuar com 2 consultas só.
      const doNumero: any = variantes.length
        ? { OR: [{ lead_id: leadId }, { lead: { tenant_id: tenantId, phone: { in: variantes } } }] }
        : { lead_id: leadId };

      // Toque que SAIU: ENVIADO na janela, ou ENVIANDO agora (o despachante só vira
      // ENVIADO depois do último balão — 10-35 s; o lead que lê o 1º e responde "pare"
      // nesse meio perdia o opt-out e o "respondeu ✓"). 15 min = ENVIANDO_PRESO_MS do
      // worker. AND (não spread): doNumero já tem OR na raiz e seria sobrescrito.
      const [ativas, ultimoEnviado] = await Promise.all([
        this.prisma.leadReactivation.count({
          where: { tenant_id: tenantId, status: 'ATIVA', ...doNumero },
        }),
        this.prisma.leadDispatch.findFirst({
          where: {
            tenant_id: tenantId,
            AND: [
              doNumero,
              {
                OR: [
                  {
                    status: 'ENVIADO',
                    sent_at: { gte: new Date(now.getTime() - EvolutionService.REATIV_RESPOSTA_JANELA_MS) },
                  },
                  { status: 'ENVIANDO', claimed_at: { gte: new Date(now.getTime() - 15 * 60000) } },
                ],
              },
            ],
          },
          // ENVIANDO não tem sent_at → nulls first (o que está saindo agora vem antes).
          orderBy: { sent_at: { sort: 'desc', nulls: 'first' } },
          select: { id: true, replied_at: true },
        }),
      ]);
      if (!ativas && !ultimoEnviado) return;

      // Irmãos (ids) — só resolvidos quando há régua de fato.
      const irmaos = new Set<string>([leadId]);
      if (variantes.length) {
        const rows = await this.prisma.lead.findMany({
          where: { tenant_id: tenantId, phone: { in: variantes } },
          select: { id: true },
        });
        for (const r of rows) irmaos.add(r.id);
      }
      const leadIds = [...irmaos];

      const curto = opts.reacao ? '' : (text || '').trim();
      const primeiraRespostaAoToque = !!ultimoEnviado && !ultimoEnviado.replied_at;
      // Opt-out PERMANENTE só pela regra ESTRITA + 1ª resposta. Recusa só pela ampla
      // ("pode parar de mandar mensagem", "me tira dessa lista") encerra como
      // RESPONDEU, sem trancar o contato.
      const optOut =
        !opts.reacao &&
        primeiraRespostaAoToque &&
        curto.length > 0 &&
        curto.length <= 60 &&
        REATIVACAO_OPT_OUT_RE.test(curto);
      const recusa = !opts.reacao && !optOut && ehRecusaDoLead(curto);
      const motivo = optOut
        ? 'pediu pra parar'
        : recusa
          ? 'respondeu (recusa)'
          : opts.reacao
            ? 'respondeu (reação)'
            : 'respondeu';

      const [toques, ciclos] = await Promise.all([
        this.prisma.leadDispatch.updateMany({
          where: { tenant_id: tenantId, lead_id: { in: leadIds }, status: 'AGENDADO' },
          data: { status: 'CANCELADO', motivo },
        }),
        this.prisma.leadReactivation.updateMany({
          where: { tenant_id: tenantId, lead_id: { in: leadIds }, status: 'ATIVA' },
          data: { status: optOut ? 'OPT_OUT' : 'RESPONDEU', motivo_fim: motivo, ended_at: now },
        }),
      ]);
      // "Respondeu ✓" no painel: marca o ÚLTIMO toque enviado (só a 1ª resposta —
      // não sobrescreve o horário se ele já respondeu antes).
      if (primeiraRespostaAoToque) {
        await this.prisma.leadDispatch.updateMany({
          where: { id: ultimoEnviado!.id, tenant_id: tenantId, replied_at: null },
          data: { replied_at: now },
        });
      }
      if (optOut) {
        // Nunca mais entra na régua — em TODOS os leads do número (senão o gêmeo
        // reentrava no próximo ciclo). Não sobrescreve um opt-out anterior.
        await this.prisma.lead.updateMany({
          where: { id: { in: leadIds }, tenant_id: tenantId, contact_opt_out_at: null },
          data: { contact_opt_out_at: now, contact_opt_out_reason: curto.slice(0, 200) },
        });
      }
      this.logger.log(
        `[REGUA-REATIV] lead ${leadId}${leadIds.length > 1 ? ` (+${leadIds.length - 1} do mesmo número)` : ''} ` +
          `${optOut ? 'pediu pra parar (opt-out)' : recusa ? 'recusou (sem opt-out)' : opts.reacao ? 'reagiu' : 'respondeu'} — ` +
          `${toques.count} toque(s) cancelado(s), ${ciclos.count} ciclo(s) encerrado(s)`,
      );
    } catch (e: any) {
      this.logger.warn(`[REGUA-REATIV] checkReactivationResponse falhou (lead ${leadId}): ${e?.message}`);
    }
  }

  /**
   * Reação (👍/❤️) do CONTATO numa mensagem da conversa = resposta: para a régua
   * (RESPONDEU, nunca opt-out). Reação não vira Message, então sem isto o toque
   * seguinte saía como se ele não tivesse respondido. Nunca pelo Financeiro
   * (nem o chip nem a conversa — reação a cobrança não é resposta à reativação).
   * Best-effort: só loga.
   */
  private async checkReactivationReaction(conversationId: string, fallbackTenantId: string | null): Promise<void> {
    try {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          lead_id: true,
          tenant_id: true,
          inbox: { select: { purpose: true } },
          lead: { select: { tenant_id: true, phone: true } },
        },
      });
      if (!conv?.lead_id || (conv.inbox as any)?.purpose === 'FINANCEIRO') return;
      const tenantId = conv.lead?.tenant_id ?? conv.tenant_id ?? fallbackTenantId ?? null;
      await this.checkReactivationResponse(conv.lead_id, tenantId, '', { phone: conv.lead?.phone ?? null, reacao: true });
    } catch (e: any) {
      this.logger.warn(`[REGUA-REATIV] reação: falha ao parar a régua (conv ${conversationId}): ${e?.message}`);
    }
  }

  // ─── Response Listener: analisa respostas de leads em follow-up ──────────

  private async checkFollowupResponse(leadId: string, responseText: string): Promise<void> {
    if (!responseText || responseText.length < 3) return;

    // Verificar se lead tem enrollment ativo
    const enrollment = await this.prisma.followupEnrollment.findFirst({
      where: { lead_id: leadId, status: 'ATIVO' },
      include: {
        sequence: { include: { steps: { orderBy: { position: 'asc' } } } },
        lead: true,
      },
      orderBy: { enrolled_at: 'desc' },
    });
    if (!enrollment) return;

    this.logger.log(
      `[FOLLOWUP-LISTENER] Resposta recebida do lead ${leadId} em sequência "${enrollment.sequence.name}"`,
    );

    // Analisar intenção com IA (resolve via ModuleRef — sem circular dep em build)
    try {
      const followupSvc = this.moduleRef.get(FollowupService, { strict: false });
      if (!followupSvc) return;

      const dossie = {
        pessoa: { nome: enrollment.lead.name, estagio: enrollment.lead.stage },
        historico: {},
        tarefa: { categoria: enrollment.sequence.category },
      };
      const analise = await followupSvc.analyzeResponse(responseText, dossie);

      this.logger.log(
        `[FOLLOWUP-LISTENER] Análise: ${analise.intencao} | sentimento: ${analise.sentimento}`,
      );

      // Pausar sequência se respondeu positivamente (quer contratar) ou negativamente (recusando)
      if (['quer_contratar', 'confirmando'].includes(analise.intencao)) {
        await this.prisma.followupEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'CONVERTIDO' },
        });
        // Criar tarefa urgente para o dentista
        await this.prisma.task.create({
          data: {
            title: `Lead quente respondeu: ${enrollment.lead.name || enrollment.lead.phone}`,
            description: `Lead respondeu positivamente ao follow-up da sequência "${enrollment.sequence.name}".\n\nResposta: "${responseText}"\n\nAnálise IA: ${analise.resumo}\nPróxima ação sugerida: ${analise.proxima_acao}`,
            status: 'A_FAZER',
            due_at: new Date(Date.now() + 2 * 3600000), // 2 horas
            lead_id: leadId,
            // Clínica do lead: sem ela a tarefa nascia órfã (sem clínica).
            tenant_id: enrollment.lead?.tenant_id ?? null,
            assigned_user_id: null, // será assignado pelo responsável
          },
        });
        this.logger.log(`[FOLLOWUP-LISTENER] Lead convertido! Tarefa urgente criada.`);
      } else if (['recusando'].includes(analise.intencao)) {
        await this.prisma.followupEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'CANCELADO', paused_reason: `Lead recusou: ${analise.resumo}` },
        });
        this.logger.log(`[FOLLOWUP-LISTENER] Lead recusou. Sequência cancelada.`);
      } else if (analise.requer_humano) {
        await this.prisma.followupEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'PAUSADO', paused_reason: `Escalado para humano: ${analise.resumo}` },
        });
        await this.prisma.task.create({
          data: {
            title: `Revisão necessária: ${enrollment.lead.name || enrollment.lead.phone}`,
            description: `A IA detectou que este lead precisa de atenção humana.\n\nResposta: "${responseText}"\n\nMotivo: ${analise.resumo}`,
            status: 'A_FAZER',
            due_at: new Date(Date.now() + 4 * 3600000),
            lead_id: leadId,
            tenant_id: enrollment.lead?.tenant_id ?? null,
            assigned_user_id: null,
          },
        });
        this.logger.log(`[FOLLOWUP-LISTENER] Escalado para humano. Sequência pausada.`);
      } else if (analise.intencao === 'pedindo_prazo') {
        // Aguardar 3 dias antes de continuar
        const resumeAt = new Date(Date.now() + 3 * 24 * 3600000);
        await this.prisma.followupEnrollment.update({
          where: { id: enrollment.id },
          data: { next_send_at: resumeAt, paused_reason: 'Lead pediu prazo para pensar' },
        });
        this.logger.log(`[FOLLOWUP-LISTENER] Lead pediu prazo — próximo envio em 3 dias`);
      }
    } catch (e: any) {
      this.logger.error(`[FOLLOWUP-LISTENER] Erro na análise: ${e.message}`);
    }
  }

  async handleChatsUpsert(payload: EvolutionWebhookPayload) {
    this.logger.debug(`Recebendo webhook de chats: ${summarizePayload(payload)}`);
    const dataPayload = payload?.data as any;
    const instanceName = payload?.instance || payload?.instanceId;
    const inbox = instanceName ? await this.inboxesService.findByInstanceName(instanceName) : null;
    const inboxId = inbox?.inbox_id || null;
    // Deriva tenant efetivo: prefere o da Instance, mas faz fallback para o Inbox pai.
    const effectiveTenantId: string | null = (inbox as any)?.tenant_id || (inbox as any)?.inbox?.tenant_id || null;

    const chats = Array.isArray(dataPayload)
      ? (dataPayload as any[])
      : [dataPayload];

    // ─── Proteção anti-flood na reconexão ──────────────────────────
    // Após reconectar a instância WhatsApp, a Evolution API envia chats.upsert
    // para TODOS os chats do dispositivo (1000+). Isso criava/reabria conversas
    // para contatos antigos, poluindo o inbox com leads irrelevantes.
    // Solução: chats.upsert NUNCA cria conversas novas nem reabre fechadas.
    // Apenas atualiza metadados (inbox_id, instance_name, foto) de conversas
    // já abertas. Conversas são criadas/reabertas APENAS via messages.upsert
    // (quando chega uma mensagem real).
    // ────────────────────────────────────────────────────────────────

    for (const data of chats) {
      if (!data) continue;

      const remoteJid = (data.remoteJidAlt || data.remoteJid) as string;
      if (!remoteJid || remoteJid.includes('@g.us')) continue;

      const phone = extractPhone(data.remoteJid as string, data.remoteJidAlt as string);
      if (phone.length > 13) continue; // LID, não é telefone real

      // Apenas atualizar leads existentes — NÃO criar novos via chats.upsert.
      // Onda 17.36 — escopo por tenant da instância (null = só órfãos).
      const existingLead = await this.leadsService.findByPhone(phone, effectiveTenantId);
      if (!existingLead) continue;

      // Atualizar foto se disponível (URLs do WhatsApp expiram)
      const profilePicUrl = (data.profilePicUrl as string) || null;
      if (profilePicUrl && profilePicUrl !== existingLead.profile_picture_url) {
        await this.prisma.lead.update({
          where: { id: existingLead.id },
          data: { profile_picture_url: profilePicUrl },
        });
      }

      // Atualizar nome se lead não tem (nunca sobrescrever)
      const pushName = (data.pushName as string) || (data.name as string) || null;
      if (pushName && !existingLead.name) {
        await this.prisma.lead.update({
          where: { id: existingLead.id },
          data: { name: pushName },
        });
      }

      // Apenas atualizar conversa ABERTA existente — NÃO reabrir fechadas, NÃO criar novas.
      // Onda 18.32 — mesmo isolamento do messages.upsert: evento vindo do chip
      // FINANCEIRO só toca conversa do Financeiro (e vice-versa), senão este update
      // de instance_name sequestrava a conversa principal pro chip de cobrança.
      const conv = await this.prisma.conversation.findFirst({
        where: {
          lead_id: existingLead.id,
          channel: 'whatsapp',
          status: 'ABERTO',
          ...((inbox as any)?.purpose === 'FINANCEIRO'
            ? { inbox: { purpose: 'FINANCEIRO' } }
            : { NOT: { inbox: { purpose: 'FINANCEIRO' } } }),
        },
      });

      if (!conv) continue; // Sem conversa aberta → pular (não criar/reabrir)

      // Atualizar metadados da conversa existente (inbox, instance)
      const updateData: any = {};
      if (inboxId && !conv.inbox_id) updateData.inbox_id = inboxId;
      if (instanceName) updateData.instance_name = instanceName;
      if (effectiveTenantId && !conv.tenant_id) updateData.tenant_id = effectiveTenantId;

      if (Object.keys(updateData).length > 0) {
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: updateData,
        });
      }

      // Sync last message ONLY if conversation already existed (no creation/reopen)
      if (data.lastMessage) {
        const lm = data.lastMessage;
        const msgId = lm.key?.id || lm.id;
        const msgText = lm.message?.conversation ||
                        lm.message?.extendedTextMessage?.text ||
                        lm.message?.imageMessage?.caption ||
                        (lm.messageType !== 'conversation' ? `[${lm.messageType}]` : '');

        if (msgId && msgText) {
          // Upsert da mensagem — apenas se é mais recente que a última
          const msgTimestamp = lm.messageTimestamp ? new Date(lm.messageTimestamp * 1000) : null;
          await this.prisma.message.upsert({
            where: { external_message_id: msgId },
            update: {
              status: lm.status || 'recebido',
            },
            create: {
              conversation_id: conv.id,
              direction: lm.key?.fromMe ? 'out' : 'in',
              type: 'text',
              text: msgText,
              external_message_id: msgId,
              status: lm.status || 'recebido',
              created_at: msgTimestamp || new Date(),
              instance_name: instanceName,
            },
          });

          // Atualizar last_message_at APENAS se o timestamp da mensagem é mais recente
          // que o current — evita bagunçar a ordenação com mensagens antigas
          if (msgTimestamp && conv.last_message_at && msgTimestamp > conv.last_message_at) {
            await this.prisma.conversation.update({
              where: { id: conv.id },
              data: { last_message_at: msgTimestamp },
            });
          }
        }
      }
    }
  }

  // ─── chats.delete ────────────────────────────────────────────
  // Quando o contato deleta o chat no WhatsApp, arquivamos a conversa no CRM
  // (status FECHADO) para não poluir o inbox. As mensagens são preservadas.
  async handleChatsDelete(payload: EvolutionWebhookPayload) {
    this.logger.log(`[WEBHOOK] chats.delete received`);
    const data = payload?.data;
    const chats = Array.isArray(data) ? data : [data];

    // Onda 17.36 — resolve o tenant da instância pra fechar SÓ conversas dele
    const delInstanceName = payload?.instance || payload?.instanceId;
    const delInbox = delInstanceName ? await this.inboxesService.findByInstanceName(delInstanceName) : null;
    const delTenantId: string | null = (delInbox as any)?.tenant_id || (delInbox as any)?.inbox?.tenant_id || null;

    for (const chat of chats) {
      if (!chat) continue;
      const remoteJid = chat.remoteJid || chat.id;
      if (!remoteJid || remoteJid.includes('@g.us')) continue;

      const phone = extractPhone(remoteJid, chat.remoteJidAlt);
      if (!phone || phone.length > 13) continue;

      const lead = await this.prisma.lead.findFirst({ where: { phone, tenant_id: delTenantId } });
      if (!lead) continue;

      // Fechar apenas conversas abertas — não alterar conversas já fechadas/adiadas
      const updated = await this.prisma.conversation.updateMany({
        where: { lead_id: lead.id, channel: 'whatsapp', status: 'ABERTO' },
        data: { status: 'FECHADO' },
      });

      if (updated.count > 0) {
        this.chatGateway.emitConversationsUpdate(lead.tenant_id ?? null, true);
        this.logger.log(`[WEBHOOK] chats.delete: ${updated.count} conversa(s) de ${phone} arquivadas`);
      }
    }
  }

  async handleMessagesUpdate(payload: EvolutionWebhookPayload) {
    this.logger.log(`[WEBHOOK] messages.update received`);
    const updates = Array.isArray(payload?.data) ? payload.data : [payload?.data];

    for (const update of updates) {
      if (!update) continue;
      // v1 (status numérico) e v2 (keyId + status em texto) — ver evolution-ack.ts.
      const ack = parseEvolutionAck(update);
      if (!ack) continue;
      const externalMessageId = ack.id;
      const newStatus = ack.status;

      try {
        const msg = await this.prisma.message.findUnique({
          where: { external_message_id: externalMessageId },
        });
        if (!msg) continue;

        // Só mensagens ENVIADAS ganham tique (o status das recebidas não muda aqui), e o
        // tique nunca regride.
        if (msg.direction === 'out' && ackSobe(msg.status, newStatus)) {
          const updated = await this.prisma.message.update({
            where: { id: msg.id },
            data: { status: newStatus },
            include: { media: true, skill: { select: { id: true, name: true, area: true } } },
          });

          this.chatGateway.emitMessageUpdate(msg.conversation_id, updated);
          this.logger.log(`[WEBHOOK] msg ${externalMessageId} status → ${newStatus}`);
        }

        // Onda 5e v25 (Fase 25, Onda C) — propaga status pra EventReminder.
        // Se essa Message corresponde a um lembrete (external_message_id bate
        // com EventReminder.external_message_id), atualiza delivered_at/read_at.
        // UI da aba Lembretes mostra os checks ✓ / ✓✓ baseado nesses campos.
        try {
          const reminder = await (this.prisma as any).eventReminder.findFirst({
            where: { external_message_id: externalMessageId },
            select: { id: true, delivered_at: true, read_at: true },
          });
          if (reminder) {
            const data: any = {};
            if (newStatus === 'entregue' && !reminder.delivered_at) data.delivered_at = new Date();
            if (newStatus === 'lido') {
              if (!reminder.delivered_at) data.delivered_at = new Date(); // lido implica entregue
              if (!reminder.read_at) data.read_at = new Date();
            }
            if (Object.keys(data).length > 0) {
              await (this.prisma as any).eventReminder.update({
                where: { id: reminder.id },
                data,
              });
              this.logger.log(`[WEBHOOK] EventReminder ${reminder.id} status → ${newStatus}`);
            }
          }
        } catch (e: any) {
          // silent — nao bloqueia o flow se reminder nao existir ou erro
        }
      } catch (e) {
        this.logger.warn(`[WEBHOOK] Falha ao atualizar status de ${externalMessageId}: ${e.message}`);
      }
    }
  }

  async handleContactsUpsert(payload: EvolutionWebhookPayload) {
    this.logger.debug(`Recebendo webhook de contatos: ${summarizePayload(payload)}`);
    const instanceName = payload?.instance || payload?.instanceId;
    // Onda 17.36 — escopo por tenant da instância
    const cuInbox = instanceName ? await this.inboxesService.findByInstanceName(instanceName) : null;
    const cuTenantId: string | null = (cuInbox as any)?.tenant_id || (cuInbox as any)?.inbox?.tenant_id || null;
    const contacts = Array.isArray(payload?.data)
      ? (payload.data as any[])
      : [payload?.data as any];

    // ─── Proteção anti-flood na reconexão ──────────────────────────
    // Após reconectar, a Evolution API envia contacts.upsert para TODOS os
    // contatos do WhatsApp (1000+), criando leads fantasma para números antigos.
    // Solução: contacts.upsert NUNCA cria leads novos — apenas atualiza
    // leads existentes (nome e foto). Leads são criados APENAS via
    // messages.upsert (quando chega uma mensagem real).
    // ────────────────────────────────────────────────────────────────

    for (const data of contacts) {
      if (!data) continue;

      const remoteJid = (data.id as string) || (data.remoteJid as string);
      if (!remoteJid || remoteJid.includes('@g.us')) continue;

      const phone = extractPhone(remoteJid, (data.remoteJidAlt as string) || (data.remoteJid as string));
      if (phone.length > 13) continue; // LID, não é telefone real

      // Apenas atualizar leads existentes — NÃO criar novos via contacts.upsert
      const existingContact = await this.leadsService.findByPhone(phone, cuTenantId);
      if (!existingContact) continue;

      const updates: Record<string, string> = {};

      // Atualizar nome se lead não tem (nunca sobrescrever nome existente)
      const name =
        (data.pushName as string) ||
        (data.name as string) ||
        (data.verifiedName as string) ||
        null;
      if (name && !existingContact.name) {
        updates.name = name;
      }

      // Buscar foto se o lead não tem
      if (instanceName && !existingContact.profile_picture_url) {
        const contactPhoto = await this.whatsappService.fetchProfilePicture(instanceName, phone).catch(() => null);
        if (contactPhoto) {
          updates.profile_picture_url = contactPhoto;
        }
      }

      if (Object.keys(updates).length === 0) continue;

      await this.prisma.lead.update({
        where: { id: existingContact.id },
        data: updates,
      });

      this.logger.log(`Contato sincronizado via webhook: ${phone} (${updates.name ? updates.name : 'nome preservado'})${updates.profile_picture_url ? ' + foto' : ''}`);
    }
  }

  // ─── messages.delete ──────────────────────────────────────────

  async handleMessagesDelete(payload: EvolutionWebhookPayload) {
    this.logger.log(`[WEBHOOK] messages.delete received`);
    const data = payload?.data;
    // Evolution v2: { key: { remoteJid, fromMe, id }, ... } or data directly
    const messageKey = data?.key || data;
    const externalId = messageKey?.id;
    if (!externalId) return;

    const msg = await this.prisma.message.findUnique({
      where: { external_message_id: externalId },
    });
    if (!msg) return;

    // Preserva conteúdo original (texto, tipo, mídia) para uso como prova.
    // Apenas marca o status — não altera type nem text.
    const updated = await this.prisma.message.update({
      where: { id: msg.id },
      data: { status: 'apagado_pelo_contato' },
      include: { media: true, skill: { select: { id: true, name: true, area: true } } },
    });

    // Emite messageUpdate — frontend ja escuta e atualiza
    this.chatGateway.emitMessageUpdate(msg.conversation_id, updated);

    this.logger.log(`[WEBHOOK] Message ${msg.id} marked as deleted by contact (content preserved)`);
  }

  // ─── contacts.update ──────────────────────────────────────────

  async handleContactsUpdate(payload: EvolutionWebhookPayload) {
    this.logger.log(`[WEBHOOK] contacts.update received`);
    const data = payload?.data;
    const instanceName = payload?.instance || payload?.instanceId;
    // Onda 17.36 — escopo por tenant da instância
    const ctInbox = instanceName ? await this.inboxesService.findByInstanceName(instanceName) : null;
    const ctTenantId: string | null = (ctInbox as any)?.tenant_id || (ctInbox as any)?.inbox?.tenant_id || null;
    const contacts = Array.isArray(data) ? data : [data];

    for (const contact of contacts) {
      if (!contact) continue;
      const jid = contact.id || contact.jid || contact.remoteJid;
      if (!jid) continue;

      const phone = jid.replace(/@.*$/, '');
      if (!phone || phone.includes('-')) continue; // Ignorar grupos
      if (phone.length > 13) continue; // LID, não é telefone real

      const lead = await this.prisma.lead.findFirst({ where: { phone, tenant_id: ctTenantId } });
      if (!lead) continue;

      const updates: Record<string, string> = {};

      // Atualizar nome apenas se:
      // 1. O contato tem nome
      // 2. O nome mudou em relação ao registrado
      // 3. O lead ainda não tem nome (null) OU o novo nome não parece ser nome do escritório.
      //    contacts.update pode disparar após msgs enviadas trazendo o pushName do escritório —
      //    para evitar sobrescrita, só aceita nome do webhook se o lead já não tiver nome.
      const newName = contact.pushName || contact.name || contact.verifiedName;
      if (newName && newName !== lead.name && !lead.name) {
        updates.name = newName;
      }

      // Buscar nova foto de perfil — URLs do WhatsApp expiram, sempre atualizar com URL fresca
      if (instanceName) {
        try {
          const newPic = await this.whatsappService.fetchProfilePicture(instanceName, phone);
          if (newPic) {
            updates.profile_picture_url = newPic;
          }
        } catch {
          // Best-effort — ignorar falha ao buscar foto
        }
      }

      if (Object.keys(updates).length === 0) continue;

      await this.prisma.lead.update({
        where: { id: lead.id },
        data: updates,
      });

      this.chatGateway.emitConversationsUpdate(lead.tenant_id ?? null);
      this.logger.log(`[WEBHOOK] Lead ${lead.id} updated: ${JSON.stringify(updates)}`);
    }
  }

  // ─── connection.update ──────────────────────────────────────────

  async handleConnectionUpdate(payload: EvolutionWebhookPayload) {
    this.logger.log(`[WEBHOOK] connection.update received`);
    const data = payload?.data;
    const instanceName = payload?.instance || payload?.instanceId;
    const state = data?.state || data?.status || 'unknown';

    // Onda 18.35 — resolve o tenant da instância pra escopar o socket (evita
    // re-render cross-tenant). connection.update é raro (só conecta/desconecta),
    // então a lookup extra é barata. tenant desconhecido → emissão global (fallback).
    const cuInbox = instanceName ? await this.inboxesService.findByInstanceName(instanceName).catch(() => null) : null;
    const cuTenantId: string | null = (cuInbox as any)?.tenant_id || (cuInbox as any)?.inbox?.tenant_id || null;

    this.chatGateway.emitConnectionStatusUpdate({
      instanceName: instanceName || 'unknown',
      state,
      statusReason: data?.statusReason,
      tenantId: cuTenantId,
    });

    this.logger.log(`[WEBHOOK] Instance ${instanceName} connection: ${state}`);

    // Quando a instância reconecta, agenda resync das mensagens perdidas durante a queda.
    // Limitamos às 50 conversas mais recentes para não sobrecarregar.
    if (state === 'open' && instanceName) {
      this.logger.log(`[RESYNC] Instância ${instanceName} reconectou — agendando resync de mensagens`);
      this.scheduleResyncAfterReconnect(instanceName, { triggerReason: 'webhook' }).catch(e =>
        this.logger.warn(`[RESYNC] Erro ao agendar resync: ${e.message}`),
      );
    }
  }

  /**
   * Dispara o resync de mensagens perdidas para uma instância.
   *
   * Fluxo em 2 fases:
   *  - Fase 1: busca chats recentes via Evolution `findChats` e cria
   *    leads/conversas para os que não existem no CRM (mensagens chegadas
   *    com o servidor fora do ar → novas conversas).
   *  - Fase 2: enfileira um job `sync_missed_messages` por conversa aberta
   *    para reimportar o histórico via `findMessages` (dedup por
   *    `external_message_id`).
   *
   * Triggers:
   *  - `webhook`   → evento `connection.update` state=open (WhatsApp reconectou)
   *  - `startup`   → subida do servidor (cobre quando o CRM caiu mas a Evolution ficou de pé)
   *  - `cron`      → rede de segurança a cada 15 min
   *  - `manual`    → endpoint administrativo `/whatsapp/instances/:name/resync`
   */
  async scheduleResyncAfterReconnect(
    instanceName: string,
    options: {
      cutoffHours?: number;
      stabilizeDelayMs?: number;
      triggerReason?: 'webhook' | 'startup' | 'cron' | 'manual';
    } = {},
  ): Promise<{ newConvsCreated: number; conversationsResynced: number }> {
    const cutoffHours = options.cutoffHours ?? 72;
    const STABILIZE_DELAY = options.stabilizeDelayMs ?? 10000;
    const reason = options.triggerReason ?? 'webhook';

    this.logger.log(
      `[RESYNC] Iniciando resync para ${instanceName} (trigger=${reason}, cutoff=${cutoffHours}h, stabilize=${STABILIZE_DELAY}ms)`,
    );

    let newConvsCreated = 0;

    // ─── FASE 1: Descobrir chats novos via Evolution API ──────────────
    // Busca chats recentes do WhatsApp e cria leads/conversas para os que
    // NÃO existem no CRM (mensagens que chegaram durante a queda do servidor).
    try {
      const recentChats = await this.whatsappService.fetchChats(instanceName);
      const inbox = await this.inboxesService.findByInstanceName(instanceName);
      const inboxId = inbox?.inbox_id || null;
      // Fallback: se a Instance não tem tenant_id, usa o do Inbox pai.
      const tenantId: string | null = (inbox as any)?.tenant_id || (inbox as any)?.inbox?.tenant_id || null;

      // Filtrar apenas chats com mensagens recentes dentro da janela configurada
      const cutoffTs = Date.now() - cutoffHours * 3600 * 1000;

      for (const chat of recentChats) {
        if (!chat) continue;
        const remoteJid = (chat.remoteJidAlt || chat.remoteJid) as string;
        if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('@broadcast') || remoteJid.includes('status@')) continue;

        const phone = extractPhone(chat.remoteJid as string, chat.remoteJidAlt as string);
        // Mesmo descarte de LID do messages.upsert — e aqui é CRÍTICO: este resync
        // CRIA lead/conversa e roda de 15 em 15min, então sem isto o contato fantasma
        // do @lid renasce sozinho (e reabre a conversa) mesmo depois de apagado.
        const chatVeioDeLid =
          isLidJid(chat.remoteJid as string) &&
          isLidJid((chat.remoteJidAlt as string) || (chat.remoteJid as string));
        if (chatVeioDeLid) continue;
        if (!phone || phone.length > 13 || phone.length < 10) continue;

        // Verificar se tem mensagem recente (dentro da janela de cutoff)
        const lastMsgTs = chat.lastMessage?.messageTimestamp
          ? Number(chat.lastMessage.messageTimestamp) * 1000
          : 0;
        if (lastMsgTs > 0 && lastMsgTs < cutoffTs) continue; // Chat antigo, ignorar

        // Verificar se já existe conversa ABERTA para este lead (escopo do tenant).
        // Onda 18.32 — escopado por mundo: resync do chip FINANCEIRO olha só as
        // conversas do Financeiro (e o resto ignora as do Financeiro).
        const resyncScope: any = (inbox as any)?.purpose === 'FINANCEIRO'
          ? { inbox: { purpose: 'FINANCEIRO' } }
          : { NOT: { inbox: { purpose: 'FINANCEIRO' } } };
        const existingLead = await this.leadsService.findByPhone(phone, tenantId);
        if (existingLead) {
          const existingConv = await this.prisma.conversation.findFirst({
            where: { lead_id: existingLead.id, channel: 'whatsapp', status: { in: ['ABERTO', 'ADIADO'] }, ...resyncScope },
          });
          if (existingConv) continue; // Já existe conversa ativa → será sincronizada na fase 2
        }

        // Chat recente sem conversa no CRM → criar lead + conversa
        const pushName = (chat.pushName as string) || (chat.name as string) || null;
        if (!existingLead && !pushName) continue; // Sem lead e sem nome → ignorar

        const lead = await this.leadsService.upsert(
          {
            phone,
            name: existingLead?.name ? null : pushName,
            ...(chat.profilePicUrl ? { profile_picture_url: chat.profilePicUrl as string } : {}),
            origin: 'whatsapp',
            ...(tenantId ? { tenant: { connect: { id: tenantId } } } : {}),
          },
          inboxId, // isola notificacao de lead novo ao inbox do setor (resync pos-reconexao)
        );

        // Reabrir conversa fechada ou criar nova (respeitando o mundo do chip)
        let conv = await this.prisma.conversation.findFirst({
          where: { lead_id: lead.id, channel: 'whatsapp', status: 'FECHADO', ...resyncScope },
          orderBy: { last_message_at: 'desc' },
        });

        if (conv) {
          conv = await this.prisma.conversation.update({
            where: { id: conv.id },
            data: {
              status: 'ABERTO',
              last_message_at: lastMsgTs ? new Date(lastMsgTs) : new Date(),
              instance_name: instanceName,
              ...(inboxId && !conv.inbox_id ? { inbox_id: inboxId } : {}),
            },
          });
        } else {
          try {
            conv = await this.prisma.conversation.create({
              data: {
                lead_id: lead.id,
                channel: 'whatsapp',
                status: 'ABERTO',
                external_id: remoteJid,
                inbox_id: inboxId,
                instance_name: instanceName,
                tenant_id: tenantId,
                last_message_at: lastMsgTs ? new Date(lastMsgTs) : new Date(),
              },
            });
          } catch (e: any) {
            // Corrida (índice único parcial): reusa a conversa que o outro criou.
            if (e?.code !== 'P2002') throw e;
            conv = await this.prisma.conversation.findFirst({
              where: { lead_id: lead.id, channel: 'whatsapp', status: { not: 'ENCERRADO' }, ...resyncScope },
              orderBy: { last_message_at: 'desc' },
            });
            if (!conv) throw e;
          }
        }

        newConvsCreated++;
        this.logger.log(`[RESYNC] Nova conversa criada para ${phone} (mensagem durante a queda)`);
      }

      if (newConvsCreated > 0) {
        this.logger.log(`[RESYNC] ${newConvsCreated} conversas novas criadas de chats recentes do WhatsApp`);
        this.chatGateway.emitConversationsUpdate(tenantId, true);
      }
    } catch (e: any) {
      this.logger.warn(`[RESYNC] Erro ao buscar chats recentes: ${e.message}`);
    }

    // ─── FASE 2: Sincronizar mensagens perdidas das conversas abertas ─
    const conversations = await this.prisma.conversation.findMany({
      where: { instance_name: instanceName, status: { in: ['ABERTO', 'ADIADO'] } },
      include: { lead: { select: { phone: true } } },
      orderBy: { last_message_at: 'desc' },
      take: 100, // Aumentado de 50 para 100
    });

    this.logger.log(
      `[RESYNC] ${conversations.length} conversas ativas para resync na instância ${instanceName} (trigger=${reason})`,
    );

    for (const conv of conversations) {
      if (!conv.lead?.phone) continue;
      await this.mediaQueue.add(
        'sync_missed_messages',
        { conversation_id: conv.id, instance_name: instanceName, phone: conv.lead.phone },
        {
          delay: STABILIZE_DELAY,
          removeOnComplete: true,
          removeOnFail: false,
          // Retry automático: se o job falhar (timeout, instância momentaneamente
          // fora, etc), tenta de novo 3x com backoff exponencial. Sem isso, um
          // soluço na rede deixava a conversa sem sincronizar até o próximo cron.
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    }

    return { newConvsCreated, conversationsResynced: conversations.length };
  }

  // ─── onApplicationBootstrap (fix principal) ─────────────────────
  // Executado uma vez quando o servidor sobe. Dispara o resync para cada
  // instância cadastrada, cobrindo o cenário em que o CRM caiu enquanto a
  // Evolution API continuou rodando: nesse caso o webhook `connection.update`
  // NUNCA é disparado (do ponto de vista da Evolution, nada mudou), então
  // o único jeito de recuperar as mensagens é o próprio CRM disparar o sync
  // ao voltar do ar.

  async onApplicationBootstrap(): Promise<void> {
    // Delay de 20s para garantir que Redis/Prisma/BullMQ estejam 100% prontos
    // e dar tempo da Evolution API reentregar webhooks que estavam em retry.
    const BOOT_DELAY = 20000;

    this.logger.log(`[BOOT] Resync de startup agendado para daqui a ${BOOT_DELAY / 1000}s`);

    setTimeout(async () => {
      try {
        const instances = await this.prisma.instance.findMany({
          where: { type: 'whatsapp' },
          select: { name: true },
        });

        if (!instances.length) {
          this.logger.log('[BOOT] Nenhuma instância de WhatsApp cadastrada — skip');
          return;
        }

        this.logger.log(
          `[BOOT] Disparando resync de startup para ${instances.length} instância(s): ${instances.map(i => i.name).join(', ')}`,
        );

        for (const inst of instances) {
          try {
            const result = await this.scheduleResyncAfterReconnect(inst.name, {
              cutoffHours: 24, // recupera mensagens das últimas 24h
              stabilizeDelayMs: 5000, // já esperamos 20s de boot, 5s extras por job bastam
              triggerReason: 'startup',
            });
            this.logger.log(
              `[BOOT] ${inst.name}: ${result.newConvsCreated} conversa(s) nova(s), ` +
                `${result.conversationsResynced} conversa(s) enfileirada(s) para resync`,
            );
          } catch (e: any) {
            this.logger.warn(`[BOOT] Resync falhou para ${inst.name}: ${e.message}`);
          }
        }
      } catch (e: any) {
        this.logger.error(`[BOOT] Erro no hook de startup: ${e.message}`);
      }
    }, BOOT_DELAY);
  }

  // ─── Cron de rede de segurança ──────────────────────────────────
  // A cada 15 minutos faz um resync leve (cutoff 2h) de todas as instâncias.
  // Protege contra webhooks que falharam silenciosamente: timeout de rede,
  // instabilidade da Evolution API, reinicialização do Redis, etc.
  // É idempotente — a UNIQUE em `external_message_id` garante que mensagens
  // já importadas são descartadas via `findUnique` antes de qualquer insert.

  @Cron('*/15 * * * *', { name: 'evolution-resync-safety-net' })
  async resyncPeriodicSafetyNet(): Promise<void> {
    try {
      const instances = await this.prisma.instance.findMany({
        where: { type: 'whatsapp' },
        select: { name: true },
      });

      if (!instances.length) return;

      this.logger.log(`[CRON] Resync de segurança para ${instances.length} instância(s)`);

      for (const inst of instances) {
        try {
          await this.scheduleResyncAfterReconnect(inst.name, {
            cutoffHours: 2, // janela curta — última fatia
            stabilizeDelayMs: 0,
            triggerReason: 'cron',
          });
        } catch (e: any) {
          this.logger.warn(`[CRON] Resync falhou para ${inst.name}: ${e.message}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`[CRON] Erro no resync periódico: ${e.message}`);
    }
  }

  // ─── presence.update ──────────────────────────────────────────

  async handlePresenceUpdate(payload: EvolutionWebhookPayload) {
    this.logger.log(`[WEBHOOK] presence.update received`);
    const data = payload?.data;
    const jid = data?.id || data?.remoteJid;
    if (!jid) return;

    const phone = jid.replace(/@.*$/, '');
    if (!phone || phone.includes('-')) return; // Ignorar grupos

    // Onda 17.36 — escopo por tenant da instância (presença é cosmética, mas
    // sem o filtro o "digitando..." aparecia na conversa de OUTRA clínica)
    const prInstanceName = payload?.instance || payload?.instanceId;
    const prInbox = prInstanceName ? await this.inboxesService.findByInstanceName(prInstanceName) : null;
    const prTenantId: string | null = (prInbox as any)?.tenant_id || (prInbox as any)?.inbox?.tenant_id || null;

    const lead = await this.prisma.lead.findFirst({ where: { phone, tenant_id: prTenantId } });
    if (!lead) return;

    const conversation = await this.prisma.conversation.findFirst({
      where: { lead_id: lead.id, status: { in: ['ABERTO', 'ADIADO'] } },
      orderBy: { last_message_at: 'desc' },
    });
    if (!conversation) return;

    // Extrair presence do payload
    const presences = data?.presences || {};
    const presenceData = Object.values(presences)[0] as any;
    const presence = presenceData?.lastKnownPresence || data?.presence || 'unavailable';

    this.chatGateway.emitContactPresence(conversation.id, {
      presence,
      lastSeen: presence === 'unavailable' ? new Date().toISOString() : undefined,
    });
  }
}
