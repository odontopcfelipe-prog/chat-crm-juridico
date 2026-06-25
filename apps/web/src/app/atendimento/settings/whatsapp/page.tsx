'use client';

/**
 * Onda 17.32.130 — UX "Conectar WhatsApp" sem config tecnica.
 *
 * O tenant nao ve mais nada de Evolution (URL, API Key, Webhook).
 * Clica num botao grande "Conectar novo WhatsApp" -> backend cria
 * instancia automatica no servidor compartilhado + retorna QR ->
 * tenant escaneia.
 *
 * Lista as linhas do tenant (filtradas por naming pattern) com
 * status, apelido renomeavel, reconectar e excluir.
 *
 * SUPER_ADMIN ve um link discreto no rodape pra "Configuracao
 * avancada do servidor Evolution" (proxima onda).
 */
import { useState, useEffect, useCallback } from 'react';
import {
  MessageSquare, Plus, RefreshCw, Loader2, Trash2, CheckCircle2,
  AlertCircle, QrCode, Pencil, X, Smartphone, AlertTriangle,
} from 'lucide-react';
import api from '@/lib/api';

interface Toast {
  type: 'success' | 'error' | 'info';
  message: string;
}

/** Traduz mensagem de erro do backend pra algo amigavel. */
function parseError(e: any): string {
  const raw = e?.response?.data?.message || e?.response?.data?.error || e?.message || '';
  if (typeof raw === 'string' && raw.startsWith('Cannot POST')) {
    return 'O servidor ainda nao reconhece essa funcionalidade. O deploy pode estar em andamento — tente de novo em alguns minutos.';
  }
  if (typeof raw === 'string' && raw.startsWith('Cannot GET')) {
    return 'O servidor ainda nao reconhece essa funcionalidade. O deploy pode estar em andamento — tente de novo em alguns minutos.';
  }
  if (e?.response?.status === 403) return 'Sem permissao pra essa acao.';
  if (e?.response?.status === 404) return 'Recurso nao encontrado no servidor.';
  if (e?.response?.status >= 500) return 'Erro interno do servidor — tente de novo em alguns segundos.';
  return raw || 'Algo deu errado. Tente de novo.';
}

type Purpose = 'COMERCIAL' | 'CLINICA';

interface MyNumber {
  instanceName: string;
  displayName: string;
  status: string;
  isLegacy?: boolean;
  /** Onda 17.64 — função do chip: COMERCIAL (Leads) | CLINICA (Pacientes) | null (geral). */
  purpose?: Purpose | null;
  profileName?: string;
  profilePictureUrl?: string;
  /** E.164 sem o '+' — ex: "5511999998888" */
  phoneNumber?: string;
  _count?: { contacts?: number; messages?: number; chats?: number };
}

// Onda 17.64 — funções do chip (máx 1 de cada por clínica).
const PURPOSES: { value: Purpose; label: string; sub: string; badge: string }[] = [
  { value: 'COMERCIAL', label: 'Comercial', sub: 'Gera Leads — time comercial', badge: 'bg-sky-500/15 text-sky-600 border-sky-500/30' },
  { value: 'CLINICA', label: 'Clínica', sub: 'Atende Pacientes — recepção/dentistas', badge: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
];
function purposeMeta(p?: string | null) {
  return PURPOSES.find((x) => x.value === p) || null;
}

/** "5511999998888" -> "+55 (11) 99999-8888" */
function formatPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  // BR: 55 + DDD(2) + numero(8 ou 9)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const country = digits.slice(0, 2);
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const split = rest.length === 9 ? 5 : 4;
    return `+${country} (${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  // Generico: adiciona '+'
  return `+${digits}`;
}

interface QrPayload {
  base64?: string;        // data:image/png;base64,...
  code?: string;          // texto cru (alt format)
  pairingCode?: string;   // codigo de 8 chars (alt format)
}

const STATUS_LABEL: Record<string, { label: string; tone: 'ok' | 'warn' | 'err' }> = {
  open:          { label: 'Conectado',       tone: 'ok' },
  connected:     { label: 'Conectado',       tone: 'ok' },
  connecting:    { label: 'Conectando…',     tone: 'warn' },
  qr:            { label: 'Aguardando QR',   tone: 'warn' },
  close:         { label: 'Desconectado',    tone: 'err' },
  disconnected:  { label: 'Desconectado',    tone: 'err' },
  unknown:       { label: 'Verificando…',    tone: 'warn' },
};

function statusOf(s: string): { label: string; tone: 'ok' | 'warn' | 'err' } {
  return STATUS_LABEL[(s || '').toLowerCase()] ?? { label: s || '?', tone: 'warn' };
}

export default function WhatsappIntegrationPage() {
  const [numbers, setNumbers] = useState<MyNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal "Conectar novo"
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPurpose, setNewPurpose] = useState<Purpose | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [qrInstance, setQrInstance] = useState<string | null>(null);
  const [qrPayload, setQrPayload] = useState<QrPayload | null>(null);

  // Modal "Renomear"
  const [renaming, setRenaming] = useState<MyNumber | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Modal "Confirmar remocao"
  const [confirmDelete, setConfirmDelete] = useState<MyNumber | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Toast (substitui os alert())
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const fetchNumbers = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get<MyNumber[]>('/whatsapp/my-numbers');
      setNumbers(res.data || []);
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 403) setError('Sem permissao pra ver as linhas de WhatsApp.');
      else setError('Nao foi possivel carregar as linhas. Tente de novo em alguns segundos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNumbers(); }, [fetchNumbers]);

  // Onda 17.32.133 — Polling RAPIDO (2s) enquanto QR aberto, pra
  // detectar conexao logo. Quando fechado, nao polla.
  useEffect(() => {
    if (!qrInstance) return;
    const t = setInterval(fetchNumbers, 2000);
    return () => clearInterval(t);
  }, [qrInstance, fetchNumbers]);

  // Onda 17.32.133 — Quando a instancia do QR vira "conectada",
  // fecha o modal automaticamente + toast de sucesso.
  useEffect(() => {
    if (!qrInstance) return;
    const me = numbers.find((n) => n.instanceName === qrInstance);
    if (!me) return;
    const s = (me.status || '').toLowerCase();
    const isConnected = ['open', 'connected', 'online', 'authenticated'].includes(s);
    if (isConnected) {
      setQrInstance(null);
      setQrPayload(null);
      setToast({
        type: 'success',
        message: `WhatsApp "${me.displayName}" conectado com sucesso!`,
      });
      // Onda 17.32.161 — Persiste a etapa do onboarding. O auto-detect
      // do backend so reconhece as keys legacy (EVOLUTION_API_KEY /
      // EVOLUTION_INSTANCE_NAME); o Quick Connect grava
      // WHATSAPP_INSTANCE_NAMES_JSON, entao quem conectava por AQUI
      // (fora do wizard) ficava com a etapa "pendente" pra sempre e o
      // wizard continuava cobrando. Best-effort: falha e silenciosa.
      api.patch('/tenants/me/onboarding/step', { step: 'whatsapp', status: 'done' })
        .catch(() => { /* onboarding e secundario aqui — nao bloqueia */ });
    }
  }, [numbers, qrInstance]);

  const handleConnect = async () => {
    if (!newPurpose) {
      setToast({ type: 'error', message: 'Escolha a função do chip (Comercial ou Clínica).' });
      return;
    }
    setConnecting(true);
    try {
      const res = await api.post<{ instanceName: string; displayName: string; qr: QrPayload | null }>(
        '/whatsapp/my-numbers/connect',
        { displayName: newDisplayName.trim() || undefined, purpose: newPurpose },
      );
      setQrInstance(res.data.instanceName);
      setQrPayload(res.data.qr);
      setShowConnectModal(false);
      setNewDisplayName('');
      setNewPurpose(null);
      fetchNumbers();
    } catch (e: any) {
      setToast({ type: 'error', message: parseError(e) });
      setShowConnectModal(false);
    } finally {
      setConnecting(false);
    }
  };

  // Onda 17.64 — define/TROCA a função de um chip a qualquer momento.
  const handleSetPurpose = async (instanceName: string, purpose: Purpose) => {
    const current = numbers.find((n) => n.instanceName === instanceName)?.purpose;
    if (current && current !== purpose) {
      if (!confirm(
        `Trocar a função deste WhatsApp de ${purposeMeta(current)?.label} pra ${purposeMeta(purpose)?.label}?\n\n` +
        `As PRÓXIMAS conversas passam a cair no setor ${purposeMeta(purpose)?.label}. ` +
        `As conversas antigas ficam onde já estão.`,
      )) return;
    }
    try {
      await api.patch(`/whatsapp/my-numbers/${encodeURIComponent(instanceName)}/purpose`, { purpose });
      setToast({ type: 'success', message: `Função: ${purposeMeta(purpose)?.label}.` });
      fetchNumbers();
    } catch (e: any) {
      setToast({ type: 'error', message: parseError(e) });
    }
  };

  const handleReconnect = async (instanceName: string) => {
    try {
      const res = await api.post<QrPayload>(`/whatsapp/my-numbers/${encodeURIComponent(instanceName)}/reconnect`);
      setQrInstance(instanceName);
      setQrPayload(res.data);
    } catch (e: any) {
      setToast({ type: 'error', message: parseError(e) });
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/whatsapp/my-numbers/${encodeURIComponent(confirmDelete.instanceName)}`);
      setToast({ type: 'success', message: `"${confirmDelete.displayName}" foi removida.` });
      setConfirmDelete(null);
      fetchNumbers();
    } catch (e: any) {
      setToast({ type: 'error', message: parseError(e) });
    } finally {
      setDeleting(false);
    }
  };

  const handleRename = async () => {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    try {
      await api.patch(`/whatsapp/my-numbers/${encodeURIComponent(renaming.instanceName)}`, { displayName: trimmed });
      setToast({ type: 'success', message: 'Apelido atualizado.' });
      setRenaming(null);
      fetchNumbers();
    } catch (e: any) {
      setToast({ type: 'error', message: parseError(e) });
    }
  };

  // Onda 17.64 — até 2 WhatsApps por clínica: no máximo 1 Comercial + 1 Clínica.
  const usedPurposes = new Set<Purpose>(
    numbers.map((n) => n.purpose).filter((p): p is Purpose => p === 'COMERCIAL' || p === 'CLINICA'),
  );
  const freePurpose: Purpose | null =
    !usedPurposes.has('CLINICA') ? 'CLINICA' : !usedPurposes.has('COMERCIAL') ? 'COMERCIAL' : null;
  const canConnectMore = numbers.length < 2 && usedPurposes.size < 2;
  const openConnect = () => { setNewPurpose(freePurpose); setShowConnectModal(true); };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <MessageSquare className="text-emerald-500" size={26} />
            WhatsApp da clínica
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {canConnectMore
              ? 'Conecte até 2 WhatsApps: 1 Comercial (Leads) e 1 Clínica (Pacientes). Cada equipe só vê o seu.'
              : 'Você já tem os 2 WhatsApps (Comercial + Clínica). Remova uma linha antes de trocar de número.'}
          </p>
        </div>
        {canConnectMore && !loading && (
          <button
            onClick={openConnect}
            className="bg-emerald-500 text-white px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20"
          >
            <Plus size={18} />
            Conectar WhatsApp
          </button>
        )}
      </header>

      {/* Erro de carga */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 flex items-center gap-3 text-sm text-rose-700">
          <AlertCircle size={18} />
          <span>{error}</span>
          <button onClick={fetchNumbers} className="ml-auto font-bold underline">Tentar de novo</button>
        </div>
      )}

      {/* Lista de números */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="animate-spin mr-2" size={20} />
          <span className="text-sm">Carregando suas linhas…</span>
        </div>
      ) : numbers.length === 0 ? (
        <EmptyState onConnect={openConnect} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {numbers.map((n) => (
            <NumberCard
              key={n.instanceName}
              number={n}
              usedPurposes={usedPurposes}
              onReconnect={() => handleReconnect(n.instanceName)}
              onDelete={() => setConfirmDelete(n)}
              onRename={() => { setRenaming(n); setRenameValue(n.displayName); }}
              onSetPurpose={(p) => handleSetPurpose(n.instanceName, p)}
            />
          ))}
        </div>
      )}

      {/* Modal: Conectar novo */}
      {showConnectModal && (
        <Modal onClose={() => setShowConnectModal(false)}>
          <h3 className="text-lg font-bold text-foreground mb-1">Conectar novo WhatsApp</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Escolha a <b>função</b> deste chip — isso decide pra qual equipe as conversas vão. Depois geramos o QR Code.
          </p>

          {/* Seletor de função (antes do QR) */}
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 block">Função do chip</label>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {PURPOSES.map((p) => {
              const used = usedPurposes.has(p.value);
              const selected = newPurpose === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  disabled={used}
                  onClick={() => setNewPurpose(p.value)}
                  className={`text-left p-3 rounded-xl border transition-all ${
                    selected
                      ? 'border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/40'
                      : used
                      ? 'border-border bg-muted/30 opacity-50 cursor-not-allowed'
                      : 'border-border hover:border-emerald-500/50 hover:bg-muted/30'
                  }`}
                >
                  <div className="text-sm font-bold text-foreground">{p.label}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{p.sub}</div>
                  {used && <div className="text-[10px] font-bold text-amber-600 mt-1">já em uso</div>}
                </button>
              );
            })}
          </div>

          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block">Apelido (opcional)</label>
          <input
            type="text"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            placeholder={newPurpose ? purposeMeta(newPurpose)?.label : 'Ex: Vendas'}
            maxLength={40}
            className="w-full bg-muted/50 border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
          />
          <p className="text-[11px] text-muted-foreground mt-2">Se deixar vazio, usamos o nome da função.</p>
          <div className="flex gap-2 mt-5 justify-end">
            <button
              onClick={() => setShowConnectModal(false)}
              className="px-4 py-2 rounded-xl text-sm font-bold text-muted-foreground hover:bg-muted/40"
            >
              Cancelar
            </button>
            <button
              disabled={connecting || !newPurpose}
              onClick={handleConnect}
              className="bg-emerald-500 text-white px-5 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-emerald-600 disabled:opacity-50"
            >
              {connecting ? <Loader2 className="animate-spin" size={16} /> : <QrCode size={16} />}
              Gerar QR Code
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: QR Code */}
      {qrInstance && (
        <Modal onClose={() => { setQrInstance(null); setQrPayload(null); fetchNumbers(); }}>
          <h3 className="text-lg font-bold text-foreground mb-1 flex items-center gap-2">
            <Smartphone className="text-emerald-500" size={20} />
            Escaneie com o WhatsApp
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            No celular: abra o WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b> → escaneie o código abaixo.
          </p>
          <QrCodeDisplay qr={qrPayload} />
          <div className="flex gap-2 mt-5 justify-between items-center">
            <button
              onClick={() => qrInstance && handleReconnect(qrInstance)}
              className="text-xs font-bold text-primary hover:underline flex items-center gap-1"
            >
              <RefreshCw size={12} />
              Gerar novo QR
            </button>
            <button
              onClick={() => { setQrInstance(null); setQrPayload(null); fetchNumbers(); }}
              className="bg-primary text-primary-foreground px-5 py-2 rounded-xl font-bold text-sm"
            >
              Fechar
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: Renomear */}
      {renaming && (
        <Modal onClose={() => setRenaming(null)}>
          <h3 className="text-lg font-bold text-foreground mb-1">Renomear linha</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Novo apelido pra "{renaming.displayName}":
          </p>
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            maxLength={40}
            className="w-full bg-muted/50 border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
            autoFocus
          />
          <div className="flex gap-2 mt-5 justify-end">
            <button
              onClick={() => setRenaming(null)}
              className="px-4 py-2 rounded-xl text-sm font-bold text-muted-foreground hover:bg-muted/40"
            >
              Cancelar
            </button>
            <button
              disabled={!renameValue.trim()}
              onClick={handleRename}
              className="bg-primary text-primary-foreground px-5 py-2 rounded-xl font-bold text-sm disabled:opacity-50"
            >
              Salvar
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: Confirmar remocao */}
      {confirmDelete && (
        <Modal onClose={() => !deleting && setConfirmDelete(null)}>
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">Remover "{confirmDelete.displayName}"?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                O WhatsApp será desconectado e a linha apagada do servidor. As conversas já recebidas
                ficam guardadas no CRC, mas o número não receberá mais mensagens até reconectar.
              </p>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              disabled={deleting}
              onClick={() => setConfirmDelete(null)}
              className="px-4 py-2 rounded-xl text-sm font-bold text-muted-foreground hover:bg-muted/40 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              disabled={deleting}
              onClick={handleDelete}
              className="bg-rose-500 text-white px-5 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-rose-600 disabled:opacity-50"
            >
              {deleting ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
              Remover
            </button>
          </div>
        </Modal>
      )}

      {/* Toast inline (substitui alert()) */}
      {toast && <ToastBanner toast={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

// ─── Toast banner ──────────────────────────────────────────────────

function ToastBanner({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const cls = toast.type === 'success'
    ? 'bg-emerald-500/95 text-white border-emerald-600'
    : toast.type === 'error'
    ? 'bg-rose-500/95 text-white border-rose-600'
    : 'bg-zinc-800/95 text-white border-zinc-700';
  const Icon = toast.type === 'success' ? CheckCircle2 : toast.type === 'error' ? AlertCircle : AlertTriangle;
  return (
    <div className="fixed bottom-6 right-6 z-[60] max-w-md animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className={`${cls} border rounded-2xl shadow-2xl p-4 pr-3 flex items-start gap-3`}>
        <Icon size={20} className="shrink-0 mt-0.5" />
        <p className="text-sm font-medium flex-1">{toast.message}</p>
        <button
          onClick={onDismiss}
          className="text-white/70 hover:text-white p-1"
          aria-label="Fechar"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

// ─── Componentes auxiliares ──────────────────────────────────────────

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="bg-card border border-dashed border-border rounded-2xl p-10 text-center">
      <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
        <MessageSquare className="text-emerald-500" size={28} />
      </div>
      <h3 className="text-lg font-bold text-foreground mb-1">Nenhum WhatsApp conectado ainda</h3>
      <p className="text-sm text-muted-foreground max-w-md mx-auto mb-5">
        Conecte o número da sua clínica em segundos. Você só precisa do celular pra escanear o QR Code.
      </p>
      <button
        onClick={onConnect}
        className="bg-emerald-500 text-white px-5 py-2.5 rounded-xl font-bold text-sm inline-flex items-center gap-2 hover:bg-emerald-600 shadow-lg shadow-emerald-500/20"
      >
        <Plus size={18} />
        Conectar agora
      </button>
    </div>
  );
}

function NumberCard({
  number, usedPurposes, onReconnect, onDelete, onRename, onSetPurpose,
}: {
  number: MyNumber;
  usedPurposes: Set<Purpose>;
  onReconnect: () => void;
  onDelete: () => void;
  onRename: () => void;
  onSetPurpose: (p: Purpose) => void;
}) {
  const s = statusOf(number.status);
  const pm = purposeMeta(number.purpose);
  const toneClass =
    s.tone === 'ok'   ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' :
    s.tone === 'warn' ? 'bg-amber-500/10  text-amber-500  border-amber-500/30'  :
                        'bg-rose-500/10   text-rose-500   border-rose-500/30';

  const phoneFormatted = formatPhone(number.phoneNumber);

  return (
    <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {number.profilePictureUrl ? (
            <img
              src={number.profilePictureUrl}
              alt={number.profileName || number.displayName}
              className="w-12 h-12 rounded-full object-cover ring-2 ring-emerald-500/20"
              referrerPolicy="no-referrer"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              <MessageSquare size={20} />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-sm font-bold text-foreground truncate">{number.displayName}</h4>
              {pm && (
                <span className={`text-[9px] font-bold uppercase border px-1.5 py-0.5 rounded ${pm.badge}`}>
                  {pm.label}
                </span>
              )}
              {number.isLegacy && (
                <span className="text-[9px] font-bold uppercase bg-amber-500/20 text-amber-600 px-1.5 py-0.5 rounded">
                  legado
                </span>
              )}
            </div>
            {number.profileName && (
              <p className="text-xs text-muted-foreground truncate">{number.profileName}</p>
            )}
            {phoneFormatted && (
              <p className="text-xs text-emerald-600 font-mono mt-0.5">{phoneFormatted}</p>
            )}
          </div>
        </div>
        <span className={`text-[10px] font-bold uppercase border px-2 py-1 rounded-full shrink-0 ${toneClass}`}>
          {s.label}
        </span>
      </div>

      {number._count && (
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{number._count.contacts ?? 0} contatos</span>
          <span>{number._count.chats ?? 0} chats</span>
        </div>
      )}

      {/* Onda 17.64 — função do chip: selecionável e TROCÁVEL a qualquer momento.
          A função usada pelo OUTRO chip fica desabilitada (1 de cada). Legado
          (sem prefixo do tenant) não suporta tag — não oferece o seletor. */}
      {!number.isLegacy && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-muted-foreground font-medium">Função:</span>
          {PURPOSES.map((p) => {
            const isCurrent = number.purpose === p.value;
            const usedByOther = usedPurposes.has(p.value) && !isCurrent;
            return (
              <button
                key={p.value}
                disabled={usedByOther}
                onClick={() => { if (!isCurrent && !usedByOther) onSetPurpose(p.value); }}
                title={usedByOther ? 'Já em uso pelo outro chip' : isCurrent ? 'Função atual' : `Mudar pra ${p.label}`}
                className={`font-bold px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 ${
                  isCurrent
                    ? p.badge
                    : usedByOther
                    ? 'opacity-40 cursor-not-allowed border-border text-muted-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted/40'
                }`}
              >
                {isCurrent && <CheckCircle2 size={11} />}
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex gap-2 pt-2 border-t border-border">
        <button
          onClick={onReconnect}
          title="Gerar novo QR Code"
          className="text-xs font-bold text-primary hover:bg-primary/10 px-3 py-1.5 rounded-lg flex items-center gap-1"
        >
          <QrCode size={12} />
          {s.tone === 'ok' ? 'Reconectar' : 'Conectar'}
        </button>
        <button
          onClick={onRename}
          title="Renomear apelido"
          className="text-xs font-bold text-muted-foreground hover:bg-muted/40 px-3 py-1.5 rounded-lg flex items-center gap-1"
        >
          <Pencil size={12} />
          Renomear
        </button>
        <button
          onClick={onDelete}
          title="Remover linha"
          className="ml-auto text-xs font-bold text-rose-500 hover:bg-rose-500/10 px-3 py-1.5 rounded-lg flex items-center gap-1"
        >
          <Trash2 size={12} />
          Remover
        </button>
      </div>
    </div>
  );
}

function QrCodeDisplay({ qr }: { qr: QrPayload | null }) {
  if (!qr) {
    return (
      <div className="bg-muted/30 rounded-xl p-10 flex flex-col items-center justify-center gap-3">
        <Loader2 className="animate-spin text-muted-foreground" size={28} />
        <span className="text-sm text-muted-foreground">Gerando QR Code…</span>
      </div>
    );
  }

  const base64 = qr.base64;
  return (
    <div className="bg-white rounded-2xl p-4 flex flex-col items-center">
      {base64 ? (
        <img
          src={base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`}
          alt="QR Code WhatsApp"
          className="w-64 h-64 rounded-lg"
        />
      ) : qr.code ? (
        <code className="text-xs break-all p-3 bg-black/5 rounded-lg text-zinc-700">{qr.code}</code>
      ) : qr.pairingCode ? (
        <div className="text-center">
          <p className="text-xs text-zinc-600 mb-2">Código de pareamento:</p>
          <div className="text-2xl font-mono font-bold tracking-widest text-zinc-900">{qr.pairingCode}</div>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">QR não disponível. Tente "Gerar novo QR".</p>
      )}
      <p className="text-[11px] text-zinc-500 mt-3 flex items-center gap-1">
        <CheckCircle2 size={11} className="text-emerald-500" />
        Quando escanear, esse modal fecha automaticamente
      </p>
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl p-6 max-w-md w-full relative shadow-2xl animate-in slide-in-from-bottom-4 duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground p-1"
          aria-label="Fechar"
        >
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}
