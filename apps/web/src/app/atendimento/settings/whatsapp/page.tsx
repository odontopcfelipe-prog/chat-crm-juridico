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
  AlertCircle, QrCode, Pencil, X, Smartphone,
} from 'lucide-react';
import api from '@/lib/api';

interface MyNumber {
  instanceName: string;
  displayName: string;
  status: string;
  isLegacy?: boolean;
  profileName?: string;
  profilePictureUrl?: string;
  _count?: { contacts?: number; messages?: number; chats?: number };
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
  const [connecting, setConnecting] = useState(false);
  const [qrInstance, setQrInstance] = useState<string | null>(null);
  const [qrPayload, setQrPayload] = useState<QrPayload | null>(null);

  // Modal "Renomear"
  const [renaming, setRenaming] = useState<MyNumber | null>(null);
  const [renameValue, setRenameValue] = useState('');

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

  // Polling discreto enquanto tem QR aberto (refresh a cada 4s)
  useEffect(() => {
    if (!qrInstance) return;
    const t = setInterval(fetchNumbers, 4000);
    return () => clearInterval(t);
  }, [qrInstance, fetchNumbers]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await api.post<{ instanceName: string; displayName: string; qr: QrPayload | null }>(
        '/whatsapp/my-numbers/connect',
        { displayName: newDisplayName.trim() || undefined },
      );
      setQrInstance(res.data.instanceName);
      setQrPayload(res.data.qr);
      setShowConnectModal(false);
      setNewDisplayName('');
      fetchNumbers();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Falha ao criar linha de WhatsApp.');
    } finally {
      setConnecting(false);
    }
  };

  const handleReconnect = async (instanceName: string) => {
    try {
      const res = await api.post<QrPayload>(`/whatsapp/my-numbers/${encodeURIComponent(instanceName)}/reconnect`);
      setQrInstance(instanceName);
      setQrPayload(res.data);
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Falha ao reconectar.');
    }
  };

  const handleDelete = async (instanceName: string, displayName: string) => {
    if (!confirm(`Remover "${displayName}"? Isso desconecta o WhatsApp e apaga a linha no servidor.`)) return;
    try {
      await api.delete(`/whatsapp/my-numbers/${encodeURIComponent(instanceName)}`);
      fetchNumbers();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Falha ao remover.');
    }
  };

  const handleRename = async () => {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    try {
      await api.patch(`/whatsapp/my-numbers/${encodeURIComponent(renaming.instanceName)}`, { displayName: trimmed });
      setRenaming(null);
      fetchNumbers();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Falha ao renomear.');
    }
  };

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
            Conecte um ou mais números — basta escanear o QR Code com o app do WhatsApp.
          </p>
        </div>
        <button
          onClick={() => setShowConnectModal(true)}
          className="bg-emerald-500 text-white px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20"
        >
          <Plus size={18} />
          Conectar novo WhatsApp
        </button>
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
        <EmptyState onConnect={() => setShowConnectModal(true)} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {numbers.map((n) => (
            <NumberCard
              key={n.instanceName}
              number={n}
              onReconnect={() => handleReconnect(n.instanceName)}
              onDelete={() => handleDelete(n.instanceName, n.displayName)}
              onRename={() => { setRenaming(n); setRenameValue(n.displayName); }}
            />
          ))}
        </div>
      )}

      {/* Modal: Conectar novo */}
      {showConnectModal && (
        <Modal onClose={() => setShowConnectModal(false)}>
          <h3 className="text-lg font-bold text-foreground mb-1">Conectar novo WhatsApp</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Dê um apelido pra essa linha (ex: <i>Vendas</i>, <i>Pós-atendimento</i>). Em seguida vamos gerar o QR Code.
          </p>
          <input
            type="text"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            placeholder="Ex: Vendas"
            maxLength={40}
            className="w-full bg-muted/50 border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary/50 transition-all"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground mt-2">Opcional — se deixar vazio, chamamos de "Linha {numbers.length + 1}".</p>
          <div className="flex gap-2 mt-5 justify-end">
            <button
              onClick={() => setShowConnectModal(false)}
              className="px-4 py-2 rounded-xl text-sm font-bold text-muted-foreground hover:bg-muted/40"
            >
              Cancelar
            </button>
            <button
              disabled={connecting}
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
  number, onReconnect, onDelete, onRename,
}: {
  number: MyNumber;
  onReconnect: () => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  const s = statusOf(number.status);
  const toneClass =
    s.tone === 'ok'   ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' :
    s.tone === 'warn' ? 'bg-amber-500/10  text-amber-500  border-amber-500/30'  :
                        'bg-rose-500/10   text-rose-500   border-rose-500/30';

  return (
    <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {number.profilePictureUrl ? (
            <img src={number.profilePictureUrl} alt="" className="w-10 h-10 rounded-full" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              <MessageSquare size={18} />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-bold text-foreground truncate">{number.displayName}</h4>
              {number.isLegacy && (
                <span className="text-[9px] font-bold uppercase bg-amber-500/20 text-amber-600 px-1.5 py-0.5 rounded">
                  legado
                </span>
              )}
            </div>
            {number.profileName && (
              <p className="text-xs text-muted-foreground truncate">{number.profileName}</p>
            )}
          </div>
        </div>
        <span className={`text-[10px] font-bold uppercase border px-2 py-1 rounded-full ${toneClass}`}>
          {s.label}
        </span>
      </div>

      {number._count && (
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{number._count.contacts ?? 0} contatos</span>
          <span>{number._count.chats ?? 0} chats</span>
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
