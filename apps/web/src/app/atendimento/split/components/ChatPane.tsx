'use client';

/**
 * ChatPane — Onda 17.22.
 *
 * Painel de chat embutivel, dedicado ao split view. Substitui o iframe
 * que carregava /atendimento/chat/[id] (com problemas de hydration,
 * sockets duplicados, peso).
 *
 * Renderiza header compacto + mensagens + input num quadrante 4-split
 * ou 6-split. Compartilha:
 *  - SocketProvider global (1 socket pra todos os slots, sem dup)
 *  - useChatSocket(leadId) — encapsula fetch + listeners
 *  - MessageBubble — componente memoizado existente
 *  - EmojiPickerButton, AudioRecorder — componentes existentes
 *
 * O que tem:
 *  ✓ Mensagens carregam direto (sem hydration mismatch)
 *  ✓ Envio de texto/emoji/áudio
 *  ✓ Receber mensagens em tempo real
 *  ✓ Status de entrega (✓ / ✓✓ / azul)
 *  ✓ IA ativa/inativa
 *  ✓ Fechar conversa
 *
 * O que NAO tem (por design — slot eh pequeno):
 *  ✗ Ficha lateral do paciente
 *  ✗ Transfer dropdown completo (só botão "Abrir conversa →" se precisar)
 *  ✗ Reply UI complexa, reactions
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Send, Bot, BotOff, X, Paperclip, ExternalLink, Loader2 } from 'lucide-react';
import { EmojiPickerButton } from '@/components/EmojiPickerButton';
import { AudioRecorder } from '@/components/AudioRecorder';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useChatSocket } from '../../hooks/useChatSocket';
import { getDateKey, formatDateLabel } from '@/lib/chatUtils';

type RenderItem =
  | { kind: 'sep'; label: string; key: string }
  | { kind: 'msg'; msg: any; idx: number };

interface Props {
  leadId: string;
  /** Header do slot (no parent) já tem nome + trocar + fechar. ChatPane
   *  só renderiza header interno mais compacto. */
  compact?: boolean;
}

export default function ChatPane({ leadId, compact = false }: Props) {
  const router = useRouter();
  const {
    messages, setMessages,
    lead, convoId, convoStatus, setConvoStatus,
    aiMode, setAiMode,
    loading,
    currentUserId,
  } = useChatSocket(leadId);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFile, setUploadingFile] = useState(false);

  // Auto-scroll ao adicionar mensagem
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Só auto-scroll se já está perto do fim (não tira o operador da leitura)
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Lista plana: separadores de data + mensagens
  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = [];
    let lastDateKey = '';
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const dateKey = msg.created_at ? getDateKey(msg.created_at) : `__nodate__${i}`;
      if (dateKey !== lastDateKey) {
        items.push({
          kind: 'sep',
          label: msg.created_at ? formatDateLabel(msg.created_at) : '(sem data)',
          key: `sep-${dateKey}-${i}`,
        });
        lastDateKey = dateKey;
      }
      items.push({ kind: 'msg', msg, idx: i });
    }
    return items;
  }, [messages]);

  /* ─── Acoes ────────────────────────────────────────────────────────── */

  const handleSend = useCallback(async () => {
    if (!text.trim() || sending || !convoId) return;
    setSending(true);
    const localText = text.trim();
    setText('');
    try {
      await api.post('/messages/send', { conversationId: convoId, text: localText });
      // Mensagem chega pelo socket — não precisa otimismo aqui
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Falha ao enviar');
      setText(localText); // restaura
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [text, sending, convoId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleAi = async () => {
    if (!convoId) return;
    const newMode = !aiMode;
    setAiMode(newMode); // otimista
    try {
      await api.patch(`/conversations/${convoId}/ai-mode`, { ai_mode: newMode });
    } catch {
      setAiMode(!newMode); // reverte
      showError('Falha ao alternar IA');
    }
  };

  const closeConvo = async () => {
    if (!convoId) return;
    if (!confirm('Fechar esta conversa?')) return;
    try {
      await api.patch(`/conversations/${convoId}/close`);
      setConvoStatus('FECHADO');
      showSuccess('Conversa fechada');
    } catch {
      showError('Falha ao fechar');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !convoId) return;
    setUploadingFile(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('conversationId', convoId);
    try {
      await api.post('/messages/send-media', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    } catch {
      showError('Falha no upload');
    } finally {
      setUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleAudioSent = (audioMsg: any) => {
    // AudioRecorder já enviou — adiciona otimisticamente caso socket atrase
    setMessages((prev) => {
      const exists = prev.some((m: any) => m.id === audioMsg.id);
      if (exists) return prev;
      return [...prev, audioMsg];
    });
  };

  const openFullChat = () => {
    if (lead?.id) router.push(`/atendimento/chat/${lead.id}`);
  };

  /* ─── Render ────────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm bg-background">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando…
      </div>
    );
  }

  if (!convoId || !lead) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-sm bg-background gap-2">
        <span>Conversa não encontrada</span>
      </div>
    );
  }

  const isClosed = convoStatus === 'FECHADO';

  return (
    <div className="h-full flex flex-col bg-background">
      {/* ─── HEADER (compact) ─── */}
      {!compact && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
          <div className="w-8 h-8 rounded-full bg-primary/10 grid place-items-center text-primary text-xs font-bold shrink-0">
            {lead.profile_picture_url ? (
              <img src={lead.profile_picture_url} alt={lead.name || '?'} className="w-full h-full rounded-full object-cover" />
            ) : (
              (lead.name || '?').charAt(0).toUpperCase()
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-foreground truncate">
              {lead.name || 'Sem nome'}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              {lead.phone || ''}
            </div>
          </div>
          <button
            onClick={openFullChat}
            className="p-1.5 rounded hover:bg-accent/30 text-muted-foreground hover:text-primary transition-colors"
            title="Abrir conversa em tela cheia"
          >
            <ExternalLink size={13} />
          </button>
          <button
            onClick={toggleAi}
            disabled={isClosed}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold transition-colors ${
              aiMode
                ? 'bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25'
                : 'bg-muted text-muted-foreground hover:bg-accent/30'
            }`}
            title={aiMode ? 'IA está respondendo automaticamente — click pra desligar' : 'IA está desligada — click pra ligar'}
          >
            {aiMode ? <Bot size={11} /> : <BotOff size={11} />}
            {aiMode ? 'IA ativa' : 'IA off'}
          </button>
          {!isClosed && (
            <button
              onClick={closeConvo}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
              title="Fechar conversa"
            >
              <X size={11} />
              Fechar
            </button>
          )}
        </div>
      )}

      {/* ─── MENSAGENS ─── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {renderItems.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            Sem mensagens ainda.
          </div>
        ) : (
          renderItems.map((item) => {
            if (item.kind === 'sep') {
              return (
                <div key={item.key} className="flex justify-center my-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-semibold">
                    {item.label}
                  </span>
                </div>
              );
            }
            const msg = item.msg;
            const isOut = msg.direction === 'out';
            const time = msg.created_at
              ? new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
              : '';
            return (
              <div key={msg.id || `tmp-${item.idx}`} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[75%] px-2.5 py-1.5 rounded-lg text-xs leading-relaxed ${
                    isOut
                      ? 'bg-primary text-primary-foreground rounded-br-sm'
                      : 'bg-card border border-border text-foreground rounded-bl-sm'
                  }`}
                >
                  {msg.text ? (
                    <span className="whitespace-pre-wrap break-words">{msg.text}</span>
                  ) : msg.type === 'audio' ? (
                    <span className="italic opacity-70">🎤 Áudio</span>
                  ) : msg.type === 'image' ? (
                    <span className="italic opacity-70">🖼️ Imagem</span>
                  ) : msg.type === 'document' ? (
                    <span className="italic opacity-70">📄 Documento</span>
                  ) : (
                    <span className="italic opacity-70">[{msg.type || 'msg'}]</span>
                  )}
                  <div className={`text-[9px] mt-0.5 ${isOut ? 'text-primary-foreground/60 text-right' : 'text-muted-foreground'}`}>
                    {time}
                    {isOut && msg.status === 'lido' && ' ✓✓'}
                    {isOut && msg.status === 'entregue' && ' ✓✓'}
                    {isOut && msg.status === 'enviado' && ' ✓'}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ─── INPUT ─── */}
      {!isClosed ? (
        <div className="border-t border-border bg-card p-2">
          <div className="flex items-end gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,application/pdf"
              className="hidden"
              onChange={handleFileUpload}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingFile || !convoId}
              className="p-1.5 rounded hover:bg-accent/30 text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
              title="Anexar arquivo"
            >
              {uploadingFile ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
            </button>
            <div className="flex-1 flex items-end bg-background border border-border rounded-lg focus-within:ring-2 focus-within:ring-primary/30">
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Digite sua mensagem..."
                rows={1}
                className="flex-1 bg-transparent px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none resize-none max-h-24"
              />
              <EmojiPickerButton onEmojiSelect={(emoji: string) => setText((t) => t + emoji)} compact />
            </div>
            {text.trim() ? (
              <button
                onClick={handleSend}
                disabled={sending || !convoId}
                className="p-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                title="Enviar"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            ) : convoId ? (
              <AudioRecorder
                conversationId={convoId}
                onSent={handleAudioSent}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="border-t border-border bg-muted/30 p-3 text-center text-xs text-muted-foreground">
          Conversa fechada
        </div>
      )}
    </div>
  );
}
