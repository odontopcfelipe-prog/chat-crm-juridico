'use client';

/**
 * Modal de preview do conteudo de um lembrete (Onda 5e v24, Fase 25, Onda B).
 *
 * Mostra:
 *   - Texto exato enviado pro paciente via WhatsApp
 *   - Status de envio (sent/falhou) + motivo de erro se houver
 *   - Respostas do paciente nas 48h apos o lembrete
 *   - Botao "Abrir conversa" pra ir pro chat completo
 *
 * Endpoint: GET /calendar/reminders/:id/preview
 */

import { useEffect, useState } from 'react';
import { X, Send, MessageSquare, Loader2, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface PreviewData {
  reminder: {
    id: string;
    minutes_before: number;
    channel: string;
    sent_at: string | null;
    last_error: string | null;
    // v25 (Onda C): delivery tracking
    delivered_at: string | null;
    read_at: string | null;
  };
  event: {
    id: string;
    title: string;
    start_at: string;
    lead: { id: string; name: string; phone: string } | null;
    // v31: patient como fallback (eventos criados via ficha do paciente)
    patient: { id: string; name: string; phone: string } | null;
    assigned_user: { name: string } | null;
  } | null;
  conversation_id: string | null;
  sent_message: {
    id: string;
    text: string;
    created_at: string;
    status: string;
  } | null;
  lead_responses: Array<{
    id: string;
    text: string;
    type: string;
    created_at: string;
  }>;
}

interface Props {
  reminderId: string;
  onClose: () => void;
}

const formatDateTime = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

export function ReminderPreviewModal({ reminderId, onClose }: Props) {
  const router = useRouter();
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.get(`/calendar/reminders/${reminderId}/preview`);
        setData(res.data);
      } catch (e: any) {
        showError(e?.response?.data?.message || 'Falha ao carregar preview');
        onClose();
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [reminderId, onClose]);

  const openConversation = () => {
    if (!data?.conversation_id) return;
    // Deep-link pro chat
    router.push(`/atendimento/chat/${data.conversation_id}`);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card text-foreground rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-5 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <MessageSquare size={18} className="text-primary" />
            <h2 className="text-base font-bold">Preview do lembrete</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : !data ? (
          <div className="p-6 text-center text-muted-foreground text-sm">
            Sem dados.
          </div>
        ) : (
          <div className="p-5 space-y-4">
            {/* Info do evento */}
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
                Evento
              </p>
              <p className="text-sm font-semibold text-foreground">{data.event?.title || '—'}</p>
              <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground flex-wrap">
                {data.event?.start_at && <span>📅 {formatDateTime(data.event.start_at)}</span>}
                {data.event?.assigned_user?.name && <span>🦷 {data.event.assigned_user.name}</span>}
                {/* v31: paciente vem de lead OU patient (depende de como evento foi criado) */}
                {(data.event?.lead?.name || data.event?.patient?.name) && (
                  <span>👤 {data.event?.lead?.name || data.event?.patient?.name}</span>
                )}
                {(data.event?.lead?.phone || data.event?.patient?.phone) && (
                  <span>📞 {data.event?.lead?.phone || data.event?.patient?.phone}</span>
                )}
              </div>
            </div>

            {/* Status do envio com TIMELINE de delivery (v25 Onda C) */}
            {data.reminder.sent_at ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 size={14} className="text-emerald-600" />
                  <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                    Status do envio
                  </span>
                </div>
                {/* Timeline visual */}
                <div className="flex items-center gap-3 mt-2 text-[11px]">
                  <div className="flex flex-col items-center gap-1">
                    <div className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                      <CheckCircle2 size={12} />
                    </div>
                    <span className="text-foreground font-semibold">Enviado</span>
                    <span className="text-[9px] text-muted-foreground">{formatDateTime(data.reminder.sent_at)}</span>
                  </div>
                  <div className={`flex-1 h-0.5 ${data.reminder.delivered_at ? 'bg-emerald-500' : 'bg-muted'}`} />
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                      data.reminder.delivered_at
                        ? 'bg-emerald-500 text-white'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      <CheckCircle2 size={12} />
                    </div>
                    <span className={data.reminder.delivered_at ? 'text-foreground font-semibold' : 'text-muted-foreground'}>
                      Entregue
                    </span>
                    {data.reminder.delivered_at && (
                      <span className="text-[9px] text-muted-foreground">{formatDateTime(data.reminder.delivered_at)}</span>
                    )}
                  </div>
                  <div className={`flex-1 h-0.5 ${data.reminder.read_at ? 'bg-sky-500' : 'bg-muted'}`} />
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                      data.reminder.read_at
                        ? 'bg-sky-500 text-white'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      <CheckCircle2 size={12} />
                    </div>
                    <span className={data.reminder.read_at ? 'text-foreground font-semibold' : 'text-muted-foreground'}>
                      Lido
                    </span>
                    {data.reminder.read_at && (
                      <span className="text-[9px] text-muted-foreground">{formatDateTime(data.reminder.read_at)}</span>
                    )}
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground mt-3">
                  {data.reminder.minutes_before}min antes • via {data.reminder.channel}
                </p>
              </div>
            ) : data.reminder.last_error ? (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle size={14} className="text-red-600" />
                  <span className="text-xs font-bold text-red-700 dark:text-red-400">
                    Falha no envio
                  </span>
                </div>
                <p className="text-[11px] text-foreground/80 mt-1">{data.reminder.last_error}</p>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-xs font-bold text-amber-700 dark:text-amber-400">
                  Pendente — vai disparar {data.reminder.minutes_before}min antes do evento
                </p>
              </div>
            )}

            {/* Mensagem enviada */}
            {data.sent_message ? (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                  <Send size={11} /> Mensagem enviada ao paciente
                </p>
                <div className="rounded-xl bg-primary/10 border border-primary/20 p-3 text-sm text-foreground whitespace-pre-wrap">
                  {data.sent_message.text}
                </div>
              </div>
            ) : data.reminder.sent_at ? (
              <p className="text-[11px] italic text-muted-foreground">
                Mensagem enviada via WhatsApp, mas o registro detalhado não foi encontrado nesta conversa.
              </p>
            ) : null}

            {/* Respostas do paciente */}
            {data.lead_responses.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                  <MessageSquare size={11} /> Respostas do paciente ({data.lead_responses.length})
                </p>
                <div className="space-y-2">
                  {data.lead_responses.map((r) => (
                    <div key={r.id} className="rounded-xl bg-muted/40 border border-border p-3">
                      <p className="text-[10px] text-muted-foreground mb-1">
                        {formatDateTime(r.created_at)}
                        {r.type !== 'text' && ` • ${r.type}`}
                      </p>
                      <p className="text-sm text-foreground whitespace-pre-wrap">
                        {r.type === 'text' ? r.text : <em className="text-muted-foreground">[{r.type}]</em>}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Botao abrir conversa */}
            {data.conversation_id && (
              <button
                onClick={openConversation}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
              >
                <ExternalLink size={13} /> Abrir conversa completa no chat
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
