'use client';

import React, { memo } from 'react';
import { Download, Mic, FileText, Trash2, Reply, Pencil, CheckCheck, Check, Bot, AlertTriangle } from 'lucide-react';
import { AudioPlayer } from '@/components/AudioPlayer';
import { MediaLoadingState } from './MediaLoadingState';
import { LinkPreview } from '@/components/LinkPreview';
import type { MessageItem } from '../types';

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

function extractFirstUrl(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(URL_REGEX);
  return match ? match[0] : null;
}

// ─── Helpers ────────────────────────────────────────────────────

// Tiques no padrão do WhatsApp: cinza (enviada/entregue) e azul (lida).
function StatusIcon({ status, isOut, onMedia }: { status: string; isOut: boolean; onMedia?: boolean }) {
  if (!isOut) return null;
  const soft = onMedia ? 'text-white' : 'wa-tick';
  if (status === 'enviando') return <span className={`inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin ${soft}`} />;
  // 'erro' = o WhatsApp recusou o envio (número fora do WhatsApp, chip desconectado…).
  // Antes caía no tique normal e a falha passava despercebida.
  if (status === 'erro') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-red-600 px-1 text-[10px] font-semibold text-white" title="Não foi enviada — o WhatsApp recusou o envio">
        <AlertTriangle size={10} /> não enviada
      </span>
    );
  }
  if (status === 'lido' || status === 'read') return <CheckCheck size={16} className="wa-tick-read" />;
  if (status === 'entregue' || status === 'delivered') return <CheckCheck size={16} className={soft} />;
  return <Check size={16} className={soft} />;
}

function formatTime(dateStr?: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function isEmojiOnly(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s)+$/u.test(t);
}

function getDocLabel(mime: string, name?: string) {
  if (name) { const p = name.split('.'); if (p.length > 1) return p.pop()!.toUpperCase(); }
  const map: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  };
  return map[mime] || 'FILE';
}

// ─── Props ──────────────────────────────────────────────────────

// Fase atual da conversa (next_step do Conversation)
const NEXT_STEP_LABELS: Record<string, string> = {
  duvidas:           '❓ Dúvidas',
  triagem_concluida: '✅ Triagem',
  entrevista:        '📝 Entrevista',
  formulario:        '📋 Formulário',
  reuniao:           '📞 Reunião',
  documentos:        '📎 Documentos',
  procuracao:        '✍️ Procuração',
  encerrado:         '🔒 Encerrado',
  perdido:           '❌ Perdido',
};

export interface MessageBubbleProps {
  msg: MessageItem;
  isOut: boolean;
  /** 1ª mensagem de uma sequência do mesmo lado: ganha o "rabinho" e o
   *  espaço maior acima (as seguintes ficam coladas, como no WhatsApp). */
  isFirstInGroup?: boolean;
  editingMsg: { id: string; text: string } | null;
  transcribing: Record<string, boolean>;
  onReply: (msg: MessageItem) => void;
  onEdit: (id: string, text: string) => void;
  onSetEditing: (edit: { id: string; text: string } | null) => void;
  onDelete: (id: string) => void;
  onTranscribe: (id: string) => void;
  onLightbox: (url: string) => void;
  onDocPreview: (preview: { url: string; name: string; mime: string }) => void;
  onImageDownload: (url: string) => void;
  onDocDownload: (url: string, name: string) => void;
  onReact?: (id: string, emoji: string) => void;
  onForward?: (msg: MessageItem) => void;
  /** Fase atual da conversa (exibida no badge da IA) */
  nextStep?: string | null;
}

// ─── Component ──────────────────────────────────────────────────

function MessageBubbleInner({
  msg,
  isOut,
  isFirstInGroup = true,
  editingMsg,
  transcribing,
  onReply,
  onEdit,
  onSetEditing,
  onDelete,
  onTranscribe,
  onLightbox,
  nextStep,
  onDocPreview,
  onImageDownload,
  onDocDownload,
  onReact,
  onForward,
}: MessageBubbleProps) {
  // Evento de transferência: aviso centralizado (como os avisos do sistema no WhatsApp)
  if (msg.type === 'transfer_event') {
    return (
      <div id={`msg-${msg.id}`} className="w-full flex justify-center wa-row-first">
        <span className="wa-system-chip">
          {msg.text} <span className="opacity-60 text-[11px] ml-1">{formatTime(msg.created_at)}</span>
        </span>
      </div>
    );
  }

  // Nota interna: só a equipe vê (não vai pro WhatsApp)
  if (msg.type === 'internal_note') {
    return (
      <div id={`msg-${msg.id}`} className="w-full flex justify-end wa-row-first">
        <div className="max-w-[80%] flex flex-col gap-1">
          <div className="flex items-center gap-1.5 justify-end">
            <span className="text-[10px] font-bold text-sky-700 uppercase tracking-wider">🔒 nota interna</span>
          </div>
          <div className="wa-bubble bg-sky-50 border border-sky-200">
            <p className="text-sky-950 whitespace-pre-wrap">{msg.text}</p>
            <div className="flex justify-end mt-1">
              <span className="wa-meta">{formatTime(msg.created_at)}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isMedia = msg.type === 'image' || msg.type === 'video' || msg.type === 'sticker';
  const caption = (msg.type === 'image' || msg.type === 'video' || msg.type === 'document') ? msg.text : null;
  const time = formatTime(msg.created_at);
  const metaContent = (onMedia?: boolean) => (
    <>
      <span>{time}</span>
      <StatusIcon status={msg.status} isOut={isOut} onMedia={onMedia} />
    </>
  );
  // Hora no fim da última linha do texto: espaçador invisível + hora flutuando no canto.
  const metaInline = (
    <>
      <span className="wa-meta wa-meta-spacer" aria-hidden>{metaContent()}</span>
      <span className="wa-meta wa-meta-float">{metaContent()}</span>
    </>
  );
  const metaRow = <div className="flex justify-end mt-1 -mb-1"><span className="wa-meta">{metaContent()}</span></div>;
  const captionBlock = caption ? (
    <div className="wa-caption">
      <span className="whitespace-pre-wrap">{caption}</span>
      {metaInline}
    </div>
  ) : null;

  const actionBtn = 'p-1.5 rounded-full text-[#8696a0] hover:text-[#54656f] hover:bg-black/5 transition-colors';
  const actions = (
    <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 self-center">
      <button onClick={() => onReply(msg)} className={actionBtn} title="Responder" aria-label="Responder mensagem">
        <Reply size={15} />
      </button>
      {onForward && msg.text && msg.type !== 'deleted' && (
        <button onClick={() => onForward(msg)} className={actionBtn} title="Encaminhar mensagem" aria-label="Encaminhar mensagem">
          <span className="text-[12px] font-bold leading-none">↪</span>
        </button>
      )}
      {isOut && (msg.type === 'text' || !msg.type) && msg.type !== 'deleted' && (
        <button onClick={() => onSetEditing({ id: msg.id, text: msg.text || '' })} className={actionBtn} title="Editar mensagem" aria-label="Editar mensagem">
          <Pencil size={15} />
        </button>
      )}
      <button onClick={() => onDelete(msg.id)} className={`${actionBtn} hover:!text-red-500`} title="Apagar mensagem" aria-label="Apagar mensagem">
        <Trash2 size={15} />
      </button>
      {onReact && msg.type !== 'deleted' && (
        <div className="relative group/react">
          <button className={`${actionBtn} text-[12px]`} title="Reagir">😊</button>
          <div className={`absolute bottom-full ${isOut ? 'right-0' : 'left-0'} mb-1 hidden group-hover/react:flex wa-reaction px-1 py-0.5 gap-0.5 z-10`}>
            {['👍','❤️','😂','😮','😢','🙏'].map(e => (
              <button key={e} onClick={() => onReact(msg.id, e)} className="p-1 hover:bg-black/5 rounded-full text-base transition-transform hover:scale-125">{e}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const hasReactions = !!msg.reactions && msg.reactions.length > 0;

  return (
    <div id={`msg-${msg.id}`} className={`w-full flex items-start gap-1 ${isOut ? 'justify-end' : 'justify-start'} group ${isFirstInGroup ? 'wa-row-first' : 'wa-row'} ${hasReactions ? 'mb-4' : ''}`}>
      {/* Ações no hover ficam do lado de DENTRO (as bolhas encostam na borda, como no WhatsApp) */}
      {isOut && actions}

      {/* Bubble wrapper (badge + bolha empilhados) */}
      <div className={`flex flex-col ${isOut ? 'items-end mr-2' : 'items-start ml-2'} gap-0.5 max-w-[85%] md:max-w-[65%]`}>

        {/* Badge de especialista IA + fase da conversa */}
        {isOut && msg.skill && isFirstInGroup && (
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/80 text-[10px] text-[#54656f] font-medium shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
              <Bot size={9} className="shrink-0" />
              <span>{msg.skill.name}</span>
            </div>
            {nextStep && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/80 text-[10px] text-[#54656f] font-medium shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
                <span>{NEXT_STEP_LABELS[nextStep] ?? nextStep}</span>
              </div>
            )}
          </div>
        )}

        {/* Bubble content */}
        <div className={`wa-bubble ${isOut ? 'wa-bubble-out' : 'wa-bubble-in'} ${isFirstInGroup ? 'wa-tail' : ''} ${isMedia ? 'wa-bubble-media' : ''}`}>
        {/* Reply context */}
        {msg.reply_to_text && msg.type !== 'deleted' && (
          <div
            className="wa-quote"
            onClick={() => {
              const el = document.getElementById(`msg-${msg.reply_to_id}`);
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el?.classList.add('ring-2', 'ring-[#00a884]/50');
              setTimeout(() => el?.classList.remove('ring-2', 'ring-[#00a884]/50'), 1500);
            }}
          >
            <p className="line-clamp-3 whitespace-pre-wrap">{msg.reply_to_text}</p>
          </div>
        )}

        {/* Deleted by contact banner — content preserved for evidence */}
        {msg.status === 'apagado_pelo_contato' && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-red-600 italic">
            <span>🚫</span> Apagada pelo contato
          </div>
        )}

        {/* Message content by type */}
        {msg.type === 'deleted' ? (
          <p className="italic text-[#667781]">&#128683; Mensagem apagada{metaInline}</p>
        ) : msg.type === 'text' || !msg.type ? (
          editingMsg?.id === msg.id ? (
            <div className="flex flex-col gap-2 min-w-[220px]">
              <textarea
                autoFocus
                rows={3}
                value={editingMsg.text}
                onChange={e => onSetEditing({ ...editingMsg, text: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEdit(editingMsg.id, editingMsg.text); }
                  if (e.key === 'Escape') onSetEditing(null);
                }}
                className="w-full bg-white/70 text-[#111b21] rounded-md p-2 text-[14.2px] resize-none outline-none border border-[#d1d7db] focus:border-[#00a884]"
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => onSetEditing(null)} className="text-[12px] px-2.5 py-1 rounded-full text-[#008069] hover:bg-black/5">Cancelar</button>
                <button onClick={() => onEdit(editingMsg.id, editingMsg.text)} className="text-[12px] px-3 py-1 rounded-full bg-[#00a884] hover:bg-[#06cf9c] text-white font-medium">Salvar</button>
              </div>
            </div>
          ) : isEmojiOnly(msg.text || '') ? (
            <>
              <p className="text-4xl leading-tight">{msg.text}</p>
              {metaRow}
            </>
          ) : extractFirstUrl(msg.text) ? (
            <>
              <p className="whitespace-pre-wrap">{msg.text}</p>
              <LinkPreview url={extractFirstUrl(msg.text)!} isOut={false} />
              {metaRow}
            </>
          ) : (
            <p>
              <span className="whitespace-pre-wrap">{msg.text}</span>
              {metaInline}
            </p>
          )
        ) : msg.type === 'audio' ? (
          <div className="pt-1">
            {msg.media ? (
              // As duas bolhas do WhatsApp são claras: o player usa sempre a paleta clara.
              <AudioPlayer
                src={`/api/media/${msg.id}`}
                duration={msg.media.duration}
                isOutgoing={false}
                messageId={msg.id}
              />
            ) : (
              <MediaLoadingState messageId={msg.id} type="audio" isOutgoing={false} />
            )}
            {msg.text ? (
              <p className="text-[12.5px] mt-2 leading-snug italic text-[#667781]">
                {msg.text}
              </p>
            ) : (
              <button
                onClick={() => onTranscribe(msg.id)}
                disabled={transcribing[msg.id]}
                className="mt-2 flex items-center gap-1 text-[11.5px] font-medium px-2.5 py-1 rounded-full transition-colors disabled:opacity-50 bg-black/5 hover:bg-black/10 text-[#54656f]"
              >
                <Mic size={11} />
                {transcribing[msg.id] ? 'Transcrevendo...' : 'Transcrever'}
              </button>
            )}
            {metaRow}
          </div>
        ) : msg.type === 'image' ? (
          msg.media ? (
            <>
              <div className="relative group/img">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/media/${msg.id}`}
                  alt="Imagem"
                  className="block max-w-full sm:max-w-[330px] max-h-[440px] object-cover rounded-[6px] cursor-pointer"
                  loading="lazy"
                  onClick={() => onLightbox(`/api/media/${msg.id}`)}
                />
                <button
                  onClick={() => onImageDownload(`/api/media/${msg.id}`)}
                  className="absolute top-1.5 right-1.5 bg-black/40 hover:bg-black/60 text-white rounded-full p-1.5 opacity-0 group-hover/img:opacity-100 transition-opacity"
                  title="Baixar imagem"
                  aria-label="Baixar imagem"
                >
                  <Download size={14} />
                </button>
                {/* Sem legenda: hora por cima da foto (como no WhatsApp) */}
                {!caption && (
                  <span className="wa-meta absolute bottom-1 right-1.5 px-1.5 rounded-full bg-black/35 !text-white">{metaContent(true)}</span>
                )}
              </div>
              {captionBlock}
            </>
          ) : (
            <MediaLoadingState messageId={msg.id} type="image" isOutgoing={false} />
          )
        ) : msg.type === 'video' ? (
          msg.media ? (
            <>
              <video src={`/api/media/${msg.id}`} controls className="block max-w-full sm:max-w-[330px] rounded-[6px]" />
              {captionBlock ?? <div className="px-1">{metaRow}</div>}
            </>
          ) : (
            <MediaLoadingState messageId={msg.id} type="video" isOutgoing={false} />
          )
        ) : msg.type === 'document' ? (
          msg.media ? (
            <>
              <div
                className="wa-doc flex items-center gap-3 cursor-pointer min-w-[220px] hover:brightness-[0.98]"
                onClick={() => onDocPreview({ url: `/api/media/${msg.id}`, name: msg.media!.original_name || 'documento', mime: msg.media!.mime_type || '' })}
              >
                <div className={`w-9 h-11 rounded-[4px] flex items-center justify-center shrink-0 text-white ${(msg.media!.mime_type || '').includes('pdf') ? 'bg-[#e5584f]' : 'bg-[#5f66cd]'}`}>
                  <FileText size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[14.2px] truncate text-[#111b21]">{msg.media!.original_name || 'Documento'}</p>
                  <p className="text-[11px] uppercase mt-0.5 text-[#667781]">{getDocLabel(msg.media!.mime_type || '', msg.media!.original_name || '')}</p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); onDocDownload(`/api/media/${msg.id}`, msg.media!.original_name || 'documento'); }}
                  className="p-1.5 rounded-full transition-colors shrink-0 text-[#8696a0] hover:text-[#54656f] hover:bg-black/5"
                  title="Baixar"
                  aria-label="Baixar documento"
                >
                  <Download size={16} />
                </button>
              </div>
              {captionBlock ?? metaRow}
            </>
          ) : (
            <MediaLoadingState messageId={msg.id} type="document" isOutgoing={false} />
          )
        ) : msg.type === 'sticker' ? (
          msg.media ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/media/${msg.id}`}
                alt="Figurinha"
                className="max-w-[140px] max-h-[140px] object-contain"
                loading="lazy"
              />
              <div className="px-1">{metaRow}</div>
            </>
          ) : (
            <p className="italic text-[#667781]">&#127917; Figurinha processando...{metaInline}</p>
          )
        ) : (
          <p className="italic text-[#667781]">&#128206; Anexo: {msg.type}{metaInline}</p>
        )}

        {/* Reações: pílula branca pendurada embaixo da bolha */}
        {hasReactions && (
          <div className={`absolute -bottom-4 ${isOut ? 'right-2' : 'left-2'} flex gap-1 z-[1]`}>
            {Object.entries(
              msg.reactions!.reduce((acc: Record<string, number>, r) => {
                acc[r.emoji] = (acc[r.emoji] || 0) + 1;
                return acc;
              }, {} as Record<string, number>)
            ).map(([emoji, count]) => (
              <button
                key={emoji}
                onClick={() => onReact?.(msg.id, emoji)}
                className="wa-reaction inline-flex items-center gap-0.5 hover:brightness-95"
              >
                <span>{emoji}</span>
                {(count as number) > 1 && <span className="text-[11px] text-[#667781]">{count as number}</span>}
              </button>
            ))}
          </div>
        )}
        </div>{/* /bubble content */}
      </div>{/* /bubble wrapper */}

      {!isOut && actions}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.text === next.msg.text &&
    prev.msg.status === next.msg.status &&
    prev.msg.type === next.msg.type &&
    prev.msg.media === next.msg.media &&
    prev.msg.reactions === next.msg.reactions &&
    prev.msg.skill === next.msg.skill &&
    prev.isOut === next.isOut &&
    prev.isFirstInGroup === next.isFirstInGroup &&
    prev.editingMsg?.id === next.editingMsg?.id &&
    (prev.editingMsg?.id !== prev.msg.id || prev.editingMsg?.text === next.editingMsg?.text) &&
    prev.transcribing[prev.msg.id] === next.transcribing[next.msg.id] &&
    prev.nextStep === next.nextStep
  );
});
