'use client';

/**
 * Botão manual "Avisar ADMs" (Progresso e Ortodontia). Manda AGORA, pelo WhatsApp da
 * clínica, o mesmo resumo de "quem está sem agendamento" do disparo automático das 8h
 * — pra todos os ADMs ou pra um específico. A janela mostra a prévia exata do texto.
 *
 * Backend: GET /pacientes-sem-agendamento/admins · GET /pacientes-sem-agendamento/preview
 * · POST /pacientes-sem-agendamento/send { kind, admin_id? }. kind 'orto' = resumo de
 * ortodontia (por dentista); sem kind = resumo geral do Progresso.
 */
import { useEffect, useState } from 'react';
import { Loader2, Megaphone, Send } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ModalBase from '@/components/ModalBase';

interface Admin { id: string; name: string; phone_tail: string }
interface SendResult { recipients: number; sent: string[]; failed: Array<{ name: string; error: string }> }

export function AvisarAdmsSemAgendamento({ kind = 'geral', className }: { kind?: 'geral' | 'orto'; className?: string }) {
  const [open, setOpen] = useState(false);
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [destino, setDestino] = useState<'todos' | 'um'>('todos');
  const [adminId, setAdminId] = useState('');
  const [sending, setSending] = useState(false);

  // Carrega ADMs + prévia a cada abertura (a prévia reflete o quadro de agora).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    Promise.all([
      api.get<Admin[]>('/pacientes-sem-agendamento/admins'),
      api.get<{ text: string }>('/pacientes-sem-agendamento/preview', { params: kind === 'orto' ? { kind } : undefined }),
    ])
      .then(([a, p]) => {
        if (cancelled) return;
        setAdmins(a.data || []);
        setPreview(p.data?.text || '');
      })
      .catch((e: any) => { if (!cancelled) showError(e?.response?.data?.message || 'Erro ao carregar o resumo'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, kind]);

  const close = () => { if (!sending) setOpen(false); };

  const send = async () => {
    if (destino === 'um' && !adminId) { showError('Escolha o administrador'); return; }
    setSending(true);
    try {
      const r = await api.post<SendResult>('/pacientes-sem-agendamento/send', {
        kind,
        ...(destino === 'um' ? { admin_id: adminId } : {}),
      });
      const { sent, failed } = r.data;
      if (sent.length) showSuccess(`Resumo enviado para ${sent.join(', ')}`);
      if (failed.length) showError(`Não entregue para ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`);
      if (sent.length) setOpen(false);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível enviar o resumo');
    } finally {
      setSending(false);
    }
  };

  const semAdmins = admins !== null && admins.length === 0;
  const titulo = kind === 'orto' ? 'Avisar ADMs — ortodontia sem agendamento' : 'Avisar ADMs — pacientes sem agendamento';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Enviar agora aos administradores quem está sem agendamento"
        className={className || 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg hover:bg-muted transition-colors shrink-0'}
      >
        <Megaphone size={14} /> Avisar ADMs
      </button>

      <ModalBase
        open={open}
        onClose={close}
        size="lg"
        title={titulo}
        subtitle="Manda agora, pelo WhatsApp da clínica, o mesmo resumo do disparo automático das 8h."
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} disabled={sending}
              className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50">
              Cancelar
            </button>
            <button type="button" onClick={send}
              disabled={sending || loading || semAdmins || (destino === 'um' && !adminId)}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50">
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar agora
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {/* Para quem */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground">Para quem</div>
            {semAdmins ? (
              <div className="text-sm rounded-lg border border-amber-300 bg-amber-50 text-amber-900 p-3">
                Nenhum administrador com telefone cadastrado. Cadastre o telefone em Configurações › Usuários.
              </div>
            ) : (
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="destino" checked={destino === 'todos'} onChange={() => setDestino('todos')} />
                  Todos os ADMs{admins ? ` (${admins.length})` : ''}
                  {admins && admins.length > 0 && (
                    <span className="text-xs text-muted-foreground truncate">— {admins.map((a) => a.name).join(', ')}</span>
                  )}
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="destino" checked={destino === 'um'} onChange={() => setDestino('um')} />
                  Um ADM específico
                </label>
                {destino === 'um' && (
                  <select
                    value={adminId}
                    onChange={(e) => setAdminId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="">Escolha o administrador…</option>
                    {(admins || []).map((a) => (
                      <option key={a.id} value={a.id}>{a.name} · final {a.phone_tail}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>

          {/* Prévia exata do que vai */}
          <div className="space-y-1.5">
            <div className="text-sm font-medium text-foreground">O que vai ser enviado</div>
            <div className="rounded-lg border border-border bg-muted/30 p-3 max-h-80 overflow-y-auto">
              {loading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 size={14} className="animate-spin" /> Montando o resumo…
                </div>
              ) : (
                <pre className="whitespace-pre-wrap font-sans text-[13px] text-foreground m-0">{preview || 'Sem prévia.'}</pre>
              )}
            </div>
          </div>
        </div>
      </ModalBase>
    </>
  );
}
