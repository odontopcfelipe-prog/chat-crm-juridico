'use client';

import { useState, useRef, useEffect } from 'react';
import { Bot, BotOff, UserCheck, CornerDownLeft, Inbox, Eye, ClipboardList, ArrowLeft, ChevronDown, ChevronRight, MoreVertical, Clock, Copy, Check, Tag, Plus, X as XIcon, RefreshCw, Calendar, UserPlus, UserMinus, IdCard } from 'lucide-react';
import { CRM_STAGES, findStage, normalizeStage } from '@/lib/crmStages';
import type { ConversationSummary, ActiveTask } from '../types';
import { ContactAvatar } from './ContactAvatar';

// LEGAL_AREAS removido — substituído pelo CRM dinâmico (Pipeline + Stage).
// Ver badge novo no header (selected.leadPipeline + selected.leadCurrentStage).
// Props legacy (specialtyDropdownRef, onChangeSpecialty, etc) mantidas como
// no-op por compat com o consumer atendimento/page.tsx — remover quando o
// consumer for atualizado pra usar PipelinesService.

function getInitial(name?: string) {
  return (name || 'V')[0].toUpperCase();
}

function formatTaskDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  if (d < now) return 'Atrasado';
  if (isToday) return `Hoje ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  if (isTomorrow) return `Amanhã ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}


export interface ChatHeaderProps {
  selected: ConversationSummary;
  selectedId: string;
  isMobile: boolean;
  isRealConvo: boolean;
  isClosed: boolean;
  aiMode: boolean;
  leadStage: string | null;
  fichaFinalizada: boolean;
  allSpecialists: { id: string; name: string; specialties: string[] }[];
  currentUserId: string | null;
  // Dropdowns
  showSpecialtyDropdown: boolean;
  showLawyerDropdown: boolean;
  showStageDropdown: boolean;
  // Refs
  specialtyDropdownRef: React.RefObject<HTMLDivElement | null>;
  lawyerDropdownRef: React.RefObject<HTMLDivElement | null>;
  stageDropdownRef: React.RefObject<HTMLDivElement | null>;
  // Callbacks
  onBack: () => void;
  onToggleSpecialty: () => void;
  onChangeSpecialty: (area: string | null) => void;
  onToggleLawyer: () => void;
  onAssignLawyer: (id: string | null) => void;
  onToggleAiMode: () => void;
  onAccept: () => void;
  onOpenTransferModal: () => void;
  hasPendingTransfer?: boolean;
  onOpenReasonPopup: (ctx: 'lawyer' | 'operator' | 'return', name: string) => void;
  onKeepInInbox: () => void;
  onToggleStage: () => void;
  onChangeStage: (stage: string) => void;
  onSendFormLink: () => void;
  onShowFicha: () => void;
  onShowDetails: () => void;
  onSetClientPanelLeadId: (id: string | null) => void;
  onLightbox: (url: string) => void;
  onCreateTask: () => void;
  // Onda 17.32.56 — Atalho de agendamento dentro da conversa
  onCreateAppointment?: () => void;
  // Onda 17.32.58 — Promover/demover Lead<->Cliente manualmente
  onPromoteToClient?: () => void;
  onDemoteToLead?: () => void;
  // Onda 17.32.59 — Cadastrar/editar dados do contato (lead)
  onCadastrarContato?: () => void;
  onSyncHistory?: () => void;
  contactPresence?: string;
  // Task management
  activeTask?: ActiveTask | null;
  onCompleteTask?: (note: string) => void;
  onPostponeTask?: (newDate: string, reason: string) => void;
  onNewTask?: () => void;
  leadTags?: string[];
  onUpdateTags?: (tags: string[]) => void;
  // CRM dinâmico (Fase 4) — lista de funis e handler pra trocar pipeline+stage
  pipelinesList?: Array<{
    id: string; name: string; slug: string; color: string | null; is_default: boolean;
    stages: Array<{ id: string; name: string; slug: string; color: string | null; emoji: string | null; position: number; is_initial: boolean; is_won: boolean; is_lost: boolean }>;
  }>;
  onChangeStageById?: (stageId: string) => void;
}

export function ChatHeader({
  selected,
  selectedId,
  isMobile,
  isRealConvo,
  isClosed,
  aiMode,
  leadStage,
  fichaFinalizada,
  allSpecialists,
  currentUserId,
  showSpecialtyDropdown,
  showLawyerDropdown,
  showStageDropdown,
  specialtyDropdownRef,
  lawyerDropdownRef,
  stageDropdownRef,
  onBack,
  onToggleSpecialty,
  onChangeSpecialty,
  onToggleLawyer,
  onAssignLawyer,
  onToggleAiMode,
  onAccept,
  onOpenTransferModal, hasPendingTransfer,
  onOpenReasonPopup,
  onKeepInInbox,
  onToggleStage,
  onChangeStage,
  onSendFormLink,
  onShowFicha,
  onShowDetails,
  onSetClientPanelLeadId,
  onLightbox,
  onCreateTask,
  onCreateAppointment,
  onPromoteToClient,
  onDemoteToLead,
  onCadastrarContato,
  onSyncHistory,
  contactPresence,
  activeTask,
  onCompleteTask,
  onPostponeTask,
  onNewTask,
  leadTags,
  onUpdateTags,
  pipelinesList,
  onChangeStageById,
}: ChatHeaderProps) {
  const [copiedPhone, setCopiedPhone] = useState(false);
  // Modais de tarefa
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [completeNote, setCompleteNote] = useState('');
  const [showPostponeModal, setShowPostponeModal] = useState(false);
  const [postponeDate, setPostponeDate] = useState('');
  const [postponeReason, setPostponeReason] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showTagInput) setTimeout(() => tagInputRef.current?.focus(), 50);
  }, [showTagInput]);

  const handleAddTag = () => {
    const t = tagInput.trim().toLowerCase().replace(/\s+/g, '_');
    if (!t || (leadTags ?? []).includes(t)) { setTagInput(''); setShowTagInput(false); return; }
    onUpdateTags?.([...(leadTags ?? []), t]);
    setTagInput('');
    setShowTagInput(false);
  };

  const handleRemoveTag = (tag: string) => {
    onUpdateTags?.((leadTags ?? []).filter(t => t !== tag));
  };
  const isAdiado = selected?.status === 'ADIADO';
  const isOverdue = activeTask?.dueAt ? new Date(activeTask.dueAt) < new Date() : false;

  return (
    <div className="shrink-0 relative z-40">
    <header className="min-h-[60px] md:min-h-[80px] py-2 md:py-3 px-3 md:px-8 border-b border-border bg-card/50 backdrop-blur-md flex items-center justify-between">
      <div className="flex items-center gap-2 md:gap-4 min-w-0 flex-1">
        {/* Botão Voltar - mobile only */}
        {isMobile && (
          <button
            onClick={onBack}
            aria-label="Voltar"
            className="p-2 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <ContactAvatar
          src={selected.profile_picture_url}
          name={selected.contactName}
          sizeClass="w-10 h-10 md:w-12 md:h-12"
          onClick={(url) => onLightbox(url)}
        />
        <div
          className="min-w-0 flex-1 cursor-pointer active:opacity-70 transition-opacity"
          onClick={() => {
            if (isMobile) {
              onShowDetails();
            } else {
              onSetClientPanelLeadId(selected.leadId);
            }
          }}
        >
          <div className="flex items-center gap-1">
            <h3 className="font-bold text-base md:text-lg leading-tight truncate">{selected.contactName || selected.contactPhone}</h3>
            <ChevronRight size={14} className="text-muted-foreground shrink-0" />
          </div>
          <div className="flex items-center gap-1 mt-0.5 md:mt-1">
            <span className="text-[11px] md:text-xs text-muted-foreground uppercase tracking-wider font-semibold truncate">
              {selected.channel} <span className="mx-1">•</span> {selected.contactPhone}
            </span>
            {selected.contactPhone && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(selected.contactPhone).then(() => {
                    setCopiedPhone(true);
                    setTimeout(() => setCopiedPhone(false), 2000);
                  });
                }}
                title="Copiar número"
                className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {copiedPhone ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
              </button>
            )}
          </div>
          {contactPresence && contactPresence !== 'unavailable' && (
            <span className="text-[10px] font-medium text-emerald-400">
              {contactPresence === 'composing' ? 'digitando...' : 'online'}
            </span>
          )}
          {/* Tags removidas — funcionalidade descontinuada */}
          {/* Especialista pré-atribuído — hidden on mobile.
              O badge de funil+etapa foi consolidado no "Etapa do Funil" do lado direito
              (ver bloco mais abaixo) pra evitar duplicação visual. */}
          <div className="hidden md:flex items-center gap-2 flex-wrap mt-1.5">
            {/* Botão "Atribuir especialista" mostrado apenas se há especialidade legada — TODO PR5: remover */}
            {selected.specialty && (
              <div className="relative" ref={lawyerDropdownRef}>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleLawyer(); }}
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors ${selected.assignedDentistName ? 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/20' : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'}`}
                  title="Clique para atribuir ou trocar o especialista"
                >
                  <UserCheck size={10} />
                  {selected.assignedDentistName || 'Atribuir especialista'}
                </button>
                {showLawyerDropdown && (
                  <div className="absolute top-full left-0 mt-1 bg-card border border-border rounded-xl shadow-xl w-56 py-1 text-[12px]" style={{ zIndex: 9999 }}>
                    <p className="px-3 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                      {selected.assignedDentistName ? 'Trocar especialista' : 'Escolher especialista'}
                    </p>
                    {allSpecialists.length === 0 && (
                      <p className="px-3 py-2 text-[11px] text-muted-foreground">Nenhum especialista cadastrado</p>
                    )}
                    {allSpecialists.map(u => (
                      <button
                        key={u.id}
                        onClick={(e) => { e.stopPropagation(); onAssignLawyer(u.id); }}
                        className={`w-full text-left px-3 py-2 hover:bg-accent transition-colors flex items-center gap-2 ${u.id === selected.assignedDentistId ? 'text-primary font-semibold' : 'text-foreground'}`}
                      >
                        <span className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-[9px] font-bold text-primary shrink-0">
                          {u.name.charAt(0)}
                        </span>
                        <div>
                          <p className="leading-tight">{u.name}</p>
                          <p className="text-[9px] text-muted-foreground">{u.specialties.join(', ')}</p>
                        </div>
                      </button>
                    ))}
                    {selected.assignedDentistId && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onAssignLawyer(null); }}
                        className="w-full text-left px-3 py-2 text-muted-foreground hover:bg-accent hover:text-destructive transition-colors text-[11px] border-t border-border mt-1"
                      >
                        Remover especialista
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2 shrink-0">
        {/* Badges informativos inline — mobile */}
        {isMobile && (
          <div className="flex items-center gap-1.5">
            {isRealConvo && (
              <span className={`w-2 h-2 rounded-full shrink-0 ${aiMode ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]' : 'bg-muted-foreground/40'}`} title={aiMode ? 'IA Ativa' : 'IA Inativa'} />
            )}
            {selected?.specialty && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 text-[9px] font-bold border border-violet-500/20">
                ⚖️ {selected.specialty}
              </span>
            )}
            {fichaFinalizada && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[9px] font-bold border border-emerald-500/20">
                ✅
              </span>
            )}
          </div>
        )}
        {/* Badges informativos — ficha trabalhista (desktop only) */}
        {selected?.specialty?.toLowerCase().includes('trabalhist') && (
          <div className="hidden md:flex gap-1.5 items-center justify-end">
            {!isClosed && (
              <button
                onClick={onSendFormLink}
                title="Enviar link do formulário trabalhista ao lead"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 text-[10px] font-bold border border-sky-500/20 hover:bg-sky-500/25 transition-colors"
              >
                <ClipboardList size={10} />
                Enviar Formulário
              </button>
            )}
            <button
              onClick={onShowFicha}
              title="Visualizar ficha trabalhista"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400 text-[10px] font-bold border border-violet-500/20 hover:bg-violet-500/25 transition-colors"
            >
              <Eye size={10} />
              Visualizar Ficha
            </button>
            {fichaFinalizada && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-bold border border-emerald-500/20">
                ✅ Finalizada
              </span>
            )}
          </div>
        )}
        {/* Botões de ação — desktop only */}
        <div className="hidden md:flex gap-2 items-center flex-wrap justify-end">
          {isRealConvo && (
            <button
              onClick={onToggleAiMode}
              title={aiMode ? 'Desativar IA' : 'Ativar IA'}
              className={`px-4 py-2 text-sm font-semibold border rounded-xl transition-colors flex items-center gap-2 ${
                aiMode
                  ? 'text-primary bg-primary/10 border-primary/20 hover:bg-primary/20'
                  : 'text-muted-foreground bg-muted/30 border-border hover:bg-muted/60'
              }`}
            >
              {aiMode ? <Bot size={16} /> : <BotOff size={16} />}
              {aiMode ? 'IA Ativa' : 'IA Inativa'}
            </button>
          )}
          {selected.status === 'WAITING' && isRealConvo && (
            <button
              onClick={onAccept}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-primary to-ring text-primary-foreground font-bold text-sm shadow-[0_0_15px_rgba(var(--primary),0.3)] hover:shadow-[0_0_20px_rgba(var(--primary),0.4)] hover:-translate-y-0.5 transition-all"
            >
              Aceitar Atendimento
            </button>
          )}
          {!isClosed && isRealConvo && (
            <button
              onClick={onOpenTransferModal}
              disabled={hasPendingTransfer}
              title={hasPendingTransfer ? 'Transferência pendente — aguardando resposta' : 'Transferir conversa para outro operador'}
              className={`px-3 py-2 text-sm font-semibold border rounded-xl transition-colors flex items-center gap-2 ${
                hasPendingTransfer
                  ? 'text-muted-foreground bg-muted/30 border-border cursor-not-allowed opacity-50'
                  : 'text-sky-400 bg-sky-500/10 border-sky-500/20 hover:bg-sky-500/20'
              }`}
            >
              <UserCheck size={16} />
              {hasPendingTransfer ? 'Aguardando...' : 'Transferir'}
            </button>
          )}
          {selected?.originAssignedUserId && selected?.assignedAgentId === currentUserId && !isClosed && (
            <>
              <button
                onClick={() => onOpenReasonPopup('return', selected?.originAssignedUserName || 'atendente de origem')}
                title="Devolver conversa ao atendente de origem"
                className="px-3 py-2 text-sm font-semibold text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-xl hover:bg-sky-500/20 transition-colors flex items-center gap-2"
              >
                <CornerDownLeft size={16} />
                Devolver
              </button>
              <button
                onClick={onKeepInInbox}
                title="Manter conversa no meu inbox"
                className="px-3 py-2 text-sm font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-xl hover:bg-emerald-500/20 transition-colors flex items-center gap-2"
              >
                <Inbox size={16} />
                Manter Aqui
              </button>
            </>
          )}
          {selected?.leadId && isRealConvo && !isClosed && (
            <button
              onClick={onCreateTask}
              title="Criar tarefa"
              className="px-3 py-2 text-sm font-semibold text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-xl hover:bg-sky-500/20 transition-colors flex items-center gap-2"
            >
              <ClipboardList size={16} />
              Tarefa
            </button>
          )}
          {/* Onda 17.32.59 — Cadastrar/editar dados do contato (lead).
              Quando o lead.name = telefone (nao foi nomeado), botao
              aparece destacado em laranja com "Cadastrar". Quando ja
              tem nome real, aparece neutro com "Editar". */}
          {selected?.leadId && isRealConvo && onCadastrarContato && (() => {
            const name = selected.contactName || '';
            const phone = selected.contactPhone || '';
            const noName = name.replace(/\D/g, '') === phone.replace(/\D/g, '');
            return (
              <button
                onClick={onCadastrarContato}
                title={noName ? 'Cadastrar contato (preencher nome, email, origem)' : 'Editar dados do contato'}
                className={`px-3 py-2 text-sm font-semibold border rounded-xl transition-colors flex items-center gap-2 ${
                  noName
                    ? 'text-orange-400 bg-orange-500/10 border-orange-500/30 hover:bg-orange-500/20 animate-pulse'
                    : 'text-muted-foreground bg-muted/30 border-border hover:bg-muted/60'
                }`}
              >
                <IdCard size={16} />
                {noName ? 'Cadastrar' : 'Editar'}
              </button>
            );
          })()}
          {/* Onda 17.32.63 — Botao "→ Cliente" removido do header.
              Movido pro modal "Editar contato" (botao "Tornar Cliente")
              pra evitar duplicacao de acoes. */}
          {/* Onda 17.32.58 — Demover Cliente -> Lead (reverte promocao
              manual). Aparece SO se ja eh cliente. */}
          {selected?.leadId && isRealConvo && !isClosed && selected?.isClient && onDemoteToLead && (
            <button
              onClick={onDemoteToLead}
              title="Voltar pra Lead (reverter promocao a cliente)"
              className="px-3 py-2 text-sm font-semibold text-muted-foreground bg-muted/30 border border-border rounded-xl hover:bg-muted/60 transition-colors flex items-center gap-2"
            >
              <UserMinus size={16} />
              → Lead
            </button>
          )}
          {/* Onda 17.32.56 — Atalho de agendamento. Abre painel lateral
              a direita sem fechar a conversa. */}
          {selected?.leadId && isRealConvo && !isClosed && onCreateAppointment && (
            <button
              onClick={onCreateAppointment}
              title="Agendar atendimento (abre painel sem sair da conversa)"
              className="px-3 py-2 text-sm font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-xl hover:bg-emerald-500/20 transition-colors flex items-center gap-2"
            >
              <Calendar size={16} />
              Agendar
            </button>
          )}
        </div>

        {/* Funil + Etapa (CRM dinâmico) — 2 badges separados, cada um com seu próprio dropdown.
            FUNIL: lista todos os pipelines, ao trocar move o lead pra etapa inicial do novo funil.
            ETAPA: lista apenas as etapas do funil atual.
            Backend: PATCH /leads/:id/stage com stage_id resolve pipeline automaticamente. */}
        {isRealConvo && pipelinesList && pipelinesList.length > 0 && (() => {
          const currentPipeline = selected.leadPipeline;
          const currentStage = selected.leadCurrentStage;
          const pipelineColor = currentPipeline?.color || '#6b7280';
          const stageColor = currentStage?.color || '#6b7280';

          // Pipeline atual no pipelinesList (pra ter as stages disponíveis)
          const fullCurrentPipeline = currentPipeline
            ? pipelinesList.find(p => p.id === currentPipeline.id)
            : null;

          // Handler: trocar pipeline → vai pra stage inicial (ou primeira) do novo
          const handlePickPipeline = (pipelineId: string) => {
            const target = pipelinesList.find(p => p.id === pipelineId);
            if (!target || !onChangeStageById) return;
            const initial = target.stages.find(s => s.is_initial) || target.stages[0];
            if (initial) onChangeStageById(initial.id);
          };

          return (
            <div className="hidden md:flex items-center gap-3">
              {/* ─── Badge FUNIL ─── */}
              <div className="relative flex items-center gap-2" ref={specialtyDropdownRef}>
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                  Funil:
                </span>
                <button
                  onClick={() => onToggleSpecialty()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all hover:opacity-80"
                  style={{ background: `${pipelineColor}18`, color: pipelineColor, borderColor: `${pipelineColor}35` }}
                  title="Clique para trocar o funil do lead"
                >
                  📁 {currentPipeline?.name || 'Sem funil'}
                  <ChevronDown size={10} className="opacity-60" />
                </button>
                {showSpecialtyDropdown && (
                  <div className="absolute top-full right-0 mt-1 bg-card border border-border rounded-xl shadow-xl w-60 py-1 max-h-[60vh] overflow-y-auto" style={{ zIndex: 9999 }}>
                    <p className="px-3 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/50">
                      Trocar Funil
                    </p>
                    {pipelinesList.map((p) => {
                      const isCurrent = currentPipeline?.id === p.id;
                      return (
                        <button
                          key={p.id}
                          onClick={() => { onToggleSpecialty(); handlePickPipeline(p.id); }}
                          disabled={isCurrent}
                          className={`w-full text-left px-3 py-2 hover:bg-accent transition-colors flex items-center gap-2 text-[12px] ${isCurrent ? 'font-bold bg-accent/30 cursor-default' : ''}`}
                          style={{ color: isCurrent ? (p.color || undefined) : undefined }}
                          title={isCurrent ? 'Funil atual' : `Mover lead para ${p.name} (etapa inicial)`}
                        >
                          <span>📁</span>
                          <span>{p.name}</span>
                          {isCurrent && <span className="ml-auto text-[9px] opacity-70">atual</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ─── Badge ETAPA ─── */}
              <div className="relative flex items-center gap-2" ref={stageDropdownRef}>
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                  Etapa:
                </span>
                <button
                  onClick={() => onToggleStage()}
                  disabled={!fullCurrentPipeline}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: `${stageColor}18`, color: stageColor, borderColor: `${stageColor}35` }}
                  title={fullCurrentPipeline ? 'Clique para trocar a etapa do lead' : 'Selecione um funil primeiro'}
                >
                  {currentStage ? (
                    <>{currentStage.emoji ? `${currentStage.emoji} ` : ''}{currentStage.name}</>
                  ) : (
                    <>— Sem etapa</>
                  )}
                  <ChevronDown size={10} className="opacity-60" />
                </button>
                {showStageDropdown && fullCurrentPipeline && (
                  <div className="absolute top-full right-0 mt-1 bg-card border border-border rounded-xl shadow-xl w-60 py-1 max-h-[60vh] overflow-y-auto" style={{ zIndex: 9999 }}>
                    <p className="px-3 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/50">
                      Etapa do Funil ({fullCurrentPipeline.name})
                    </p>
                    {fullCurrentPipeline.stages.map((s) => {
                      const isActive = currentStage?.id === s.id;
                      return (
                        <button
                          key={s.id}
                          onClick={() => onChangeStageById && onChangeStageById(s.id)}
                          disabled={isActive}
                          className={`w-full text-left px-3 py-2 hover:bg-accent transition-colors flex items-center gap-2 text-[12px] ${isActive ? 'font-bold bg-accent/30 cursor-default' : ''}`}
                          style={{ color: isActive ? (s.color || undefined) : undefined }}
                          title={isActive ? 'Etapa atual' : `Mover para ${s.name}`}
                        >
                          <span className="opacity-70">{s.emoji || '•'}</span>
                          <span>{s.name}</span>
                          {s.is_won && <span className="ml-auto text-[9px] text-emerald-500">✓ ganho</span>}
                          {s.is_lost && <span className="ml-auto text-[9px] text-red-500">✕ perdido</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </header>

    {/* ── Barra de tarefa ativa — aparece sempre que houver activeTask ── */}
    {activeTask && (
      <div className={`flex items-center gap-2 px-3 md:px-6 py-2 border-b ${
        isOverdue ? 'bg-red-500/5 border-red-500/20' : 'bg-sky-500/5 border-sky-500/20'
      }`}>
        <Clock size={13} className={`shrink-0 ${isOverdue ? 'text-red-400 animate-pulse' : 'text-sky-400'}`} />
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold truncate ${isOverdue ? 'text-red-400' : 'text-sky-300'}`}>
            {activeTask.title}
            {activeTask.dueAt && (
              <span className={`ml-2 text-[10px] font-bold ${isOverdue ? 'text-red-500' : 'opacity-60'}`}>
                {formatTaskDate(activeTask.dueAt)}
              </span>
            )}
          </p>
          {(activeTask.postponeCount ?? 0) > 0 && (
            <p className="text-[9px] text-sky-400/60 font-medium">
              {activeTask.postponeCount}ª vez adiando
            </p>
          )}
        </div>

        {/* Concluir */}
        <button
          onClick={() => { setCompleteNote(''); setShowCompleteModal(true); }}
          className="px-2.5 py-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/20 transition-colors whitespace-nowrap"
        >
          ✓ Concluir
        </button>

        {/* Adiar */}
        <button
          onClick={() => { setPostponeDate(''); setPostponeReason(''); setShowPostponeModal(true); }}
          className="px-2.5 py-1 text-[11px] font-bold text-sky-400 bg-sky-500/10 border border-sky-500/20 rounded-lg hover:bg-sky-500/20 transition-colors whitespace-nowrap"
        >
          ⏰ Adiar
        </button>

        {/* Nova tarefa */}
        <button
          onClick={onNewTask}
          className="px-2.5 py-1 text-[11px] font-bold text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-lg hover:bg-sky-500/20 transition-colors whitespace-nowrap"
          title="Criar nova tarefa para este contato"
        >
          + Nova
        </button>
      </div>
    )}

    {/* ── Modal: Concluir tarefa ── */}
    {showCompleteModal && activeTask && (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={() => setShowCompleteModal(false)}
      >
        <div
          className="bg-card border border-border rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">✅</span>
            <h3 className="font-bold text-sm">Concluir tarefa</h3>
          </div>
          <p className="text-xs text-sky-300/80 mb-4 truncate font-medium">{activeTask.title}</p>

          <label className="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">
            Como foi? <span className="text-muted-foreground/40 font-normal normal-case">(opcional)</span>
          </label>
          <textarea
            value={completeNote}
            onChange={e => setCompleteNote(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Ex: Cliente confirmou que vai enviar os documentos amanhã"
            className="w-full px-3 py-2 text-sm bg-accent/50 border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40 resize-none text-foreground placeholder:text-muted-foreground/40"
          />

          <div className="flex gap-2 mt-4 justify-end">
            <button
              onClick={() => setShowCompleteModal(false)}
              className="px-4 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() => {
                onCompleteTask?.(completeNote.trim());
                setShowCompleteModal(false);
                setCompleteNote('');
              }}
              className="px-4 py-2 text-sm font-bold rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
            >
              ✓ Confirmar conclusão
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── Modal: Adiar tarefa ── */}
    {showPostponeModal && activeTask && (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={() => setShowPostponeModal(false)}
      >
        <div
          className="bg-card border border-border rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">⏰</span>
            <h3 className="font-bold text-sm">Adiar tarefa</h3>
          </div>
          <p className="text-xs text-sky-300/80 mb-1 truncate font-medium">{activeTask.title}</p>
          {(activeTask.postponeCount ?? 0) > 0 && (
            <p className="text-[10px] text-sky-400 font-semibold mb-3">
              {activeTask.postponeCount}ª vez adiando esta tarefa
            </p>
          )}

          <label className="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">
            Nova data e hora
          </label>
          <input
            type="datetime-local"
            value={postponeDate}
            onChange={e => setPostponeDate(e.target.value)}
            className="w-full mb-4 px-3 py-2 text-sm bg-accent/50 border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40 text-foreground [color-scheme:dark]"
          />

          <label className="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">
            Motivo <span className="text-red-400">*</span>
          </label>
          <textarea
            value={postponeReason}
            onChange={e => setPostponeReason(e.target.value)}
            rows={2}
            autoFocus
            placeholder="Ex: Cliente não atendeu, ligarei novamente amanhã"
            className="w-full px-3 py-2 text-sm bg-accent/50 border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40 resize-none text-foreground placeholder:text-muted-foreground/40"
          />

          <div className="flex gap-2 mt-4 justify-end">
            <button
              onClick={() => setShowPostponeModal(false)}
              className="px-4 py-2 text-sm rounded-lg border border-border text-muted-foreground hover:bg-accent transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() => {
                if (postponeDate && postponeReason.trim()) {
                  onPostponeTask?.(postponeDate, postponeReason.trim());
                  setShowPostponeModal(false);
                  setPostponeDate('');
                  setPostponeReason('');
                }
              }}
              disabled={!postponeDate || !postponeReason.trim()}
              className="px-4 py-2 text-sm font-bold rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-400 hover:bg-sky-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ⏰ Confirmar adiamento
            </button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
