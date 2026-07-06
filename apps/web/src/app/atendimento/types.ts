export interface ActiveTask {
  id: string;
  title: string;
  dueAt: string | null;
  status: string;
  assignedUserId: string | null;
  postponeCount?: number;
}

export interface ConversationSummary {
  id: string;
  leadId: string;
  contactName: string;
  contactPhone: string;
  channel: string;
  status: string;
  lastMessage: string;
  lastMessageAt: string;
  assignedAgentId?: string | null;
  assignedAgentName: string | null;
  aiMode: boolean;
  profile_picture_url?: string | null;
  inboxId?: string | null;
  inboxPurpose?: string | null; // Onda 18.33 — COMERCIAL|CLINICA|FINANCEIRO (esconde ações na conversa de cobrança)
  specialty?: string | null;
  assignedDentistId?: string | null;
  assignedDentistName?: string | null;
  originAssignedUserId?: string | null;
  originAssignedUserName?: string | null;
  leadStage?: string | null;
  leadTags?: string[];
  stageEnteredAt?: string | null;
  nextStep?: string | null;
  activeTask?: ActiveTask | null;
  hasNotes?: boolean;
  isClient?: boolean;
  // CRM dinâmico (Fase 4 — pipelines)
  leadPipeline?: { id: string; name: string; slug: string; color: string | null } | null;
  leadCurrentStage?: {
    id: string;
    name: string;
    slug: string;
    color: string | null;
    emoji: string | null;
    is_won: boolean;
    is_lost: boolean;
  } | null;
}

export interface MessageReaction {
  id: string;
  message_id: string;
  user_id?: string | null;
  contact_jid?: string | null;
  emoji: string;
  created_at: string;
}

export interface MessageItem {
  id: string;
  conversation_id: string;
  external_message_id?: string | null;
  direction: 'in' | 'out';
  type: string;
  text: string | null;
  status: string;
  created_at: string;
  reply_to_id?: string | null;
  reply_to_text?: string | null;
  media?: { original_url?: string; mime_type?: string; duration?: number | null; original_name?: string | null } | null;
  reactions?: MessageReaction[];
  skill?: { id: string; name: string; area: string } | null;
}

export interface ConversationNoteItem {
  id: string;
  conversation_id: string;
  user_id: string;
  text: string;
  created_at: string;
  updated_at: string;
  user: { id: string; name: string };
}
