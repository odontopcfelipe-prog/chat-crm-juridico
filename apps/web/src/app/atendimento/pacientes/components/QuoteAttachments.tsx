'use client';

/**
 * QuoteAttachments — UI de anexos do orçamento (Fase 24 — Onda 3).
 *
 * Permite operador:
 *  - Drag & drop OU click pra subir arquivo (imagens/PDF/Word)
 *  - Categorizar (livre): "Antes/Depois", "Exame", "TCLE", "Receita"
 *  - Adicionar descrição opcional
 *  - Ver grid: thumbnail (pra imagens) ou ícone (PDF/doc) com nome+tamanho
 *  - Click na imagem abre preview em nova aba
 *  - Remover (lixeira no hover)
 *
 * Use cases que vendem:
 *  - Estética facial: foto antes/depois junto com orçamento → conversão sobe
 *  - Implante: foto do RX panorâmico → paciente entende complexidade
 */
import { useEffect, useRef, useState } from 'react';
import {
  Paperclip, Loader2, Plus, Trash2, FileText, Image as ImageIcon,
  Download, Eye, Upload, X,
} from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  category: string | null;
  description: string | null;
  created_at: string;
  uploaded_by: { id: string; name: string };
}

interface Props {
  quoteId: string;
  /** Status do orçamento — se REJECTED/EXPIRED, bloqueia upload/delete */
  quoteStatus: string;
}

const PRESET_CATEGORIES = [
  'Antes/Depois',
  'Exame',
  'TCLE',
  'Receita',
  'Plano de tratamento',
  'Outro',
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

function isPdf(mime: string): boolean {
  return mime === 'application/pdf';
}

export default function QuoteAttachments({ quoteId, quoteStatus }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [list, setList] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [category, setCategory] = useState('Antes/Depois');
  const [description, setDescription] = useState('');

  const canEdit = !['REJECTED', 'EXPIRED'].includes(quoteStatus);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Attachment[]>(`/quotes/${quoteId}/attachments`);
      setList(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar anexos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [quoteId]);

  const handleFileSelected = (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      showError('Arquivo maior que 10 MB');
      return;
    }
    setPendingFile(file);
  };

  const handleUpload = async () => {
    if (!pendingFile) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', pendingFile);
      if (category) fd.append('category', category);
      if (description.trim()) fd.append('description', description.trim());
      await api.post(`/quotes/${quoteId}/attachments`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      showSuccess('Anexo enviado');
      setPendingFile(null);
      setDescription('');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao enviar anexo');
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async (att: Attachment) => {
    if (!confirm(`Remover anexo "${att.filename}"?`)) return;
    try {
      await api.delete(`/quote-attachments/${att.id}`);
      showSuccess('Anexo removido');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  /** Abre arquivo em nova aba — fetch + blob pra mandar Authorization header */
  const openAttachment = (att: Attachment) => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API_BASE_URL}/quote-attachments/${att.id}/file`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(() => showError('Falha ao abrir arquivo'));
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Paperclip size={14} className="text-primary" />
          Anexos
          {list.length > 0 && (
            <span className="text-xs text-muted-foreground">({list.length})</span>
          )}
        </h3>
        {canEdit && (
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus size={11} /> Adicionar
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFileSelected(f);
            e.target.value = '';
          }}
        />
      </div>

      {/* Form de upload (quando arquivo selecionado, antes de salvar) */}
      {pendingFile && (
        <div className="mb-3 p-3 rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            {isImage(pendingFile.type) ? (
              <ImageIcon size={16} className="text-primary" />
            ) : (
              <FileText size={16} className="text-primary" />
            )}
            <span className="font-medium truncate">{pendingFile.name}</span>
            <span className="text-xs text-muted-foreground">
              {formatSize(pendingFile.size)}
            </span>
            <button
              onClick={() => setPendingFile(null)}
              className="ml-auto text-muted-foreground hover:text-foreground"
            >
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="px-2 py-1.5 rounded bg-background border border-border text-xs"
            >
              {PRESET_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descrição (opcional)"
              className="px-2 py-1.5 rounded bg-background border border-border text-xs"
            />
          </div>
          <button
            onClick={handleUpload}
            disabled={uploading}
            className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Enviar arquivo
          </button>
        </div>
      )}

      {/* Lista de anexos (grid de cards) */}
      {loading ? (
        <div className="py-6 text-center text-xs text-muted-foreground">
          <Loader2 size={14} className="inline animate-spin mr-1" /> Carregando
        </div>
      ) : list.length === 0 ? (
        <div className="py-6 text-center">
          <Paperclip size={20} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">
            Nenhum anexo ainda.
            {canEdit && ' Adicione fotos antes/depois, exames ou documentos auxiliares.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {list.map((att) => (
            <AttachmentCard
              key={att.id}
              attachment={att}
              canDelete={canEdit}
              onOpen={() => openAttachment(att)}
              onDelete={() => handleRemove(att)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AttachmentCard({
  attachment: att, canDelete, onOpen, onDelete,
}: {
  attachment: Attachment;
  canDelete: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // Pra imagens, mostra thumbnail carregado via fetch + blob URL (auth header)
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbLoading, setThumbLoading] = useState(false);

  useEffect(() => {
    if (!isImage(att.mime_type)) return;
    let cancelled = false;
    setThumbLoading(true);
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) return;
    fetch(`${API_BASE_URL}/quote-attachments/${att.id}/file`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.blob())
      .then((blob) => {
        if (cancelled) return;
        setThumbUrl(URL.createObjectURL(blob));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setThumbLoading(false); });
    return () => {
      cancelled = true;
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.id, att.mime_type]);

  return (
    <div className="group bg-background border border-border rounded-lg overflow-hidden hover:border-primary/40 transition-colors">
      {/* Thumbnail / icone */}
      <button
        onClick={onOpen}
        className="w-full aspect-[4/3] bg-muted/50 flex items-center justify-center relative overflow-hidden"
        title="Click pra abrir em nova aba"
      >
        {isImage(att.mime_type) ? (
          thumbLoading ? (
            <Loader2 size={20} className="text-muted-foreground animate-spin" />
          ) : thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbUrl} alt={att.filename} className="w-full h-full object-cover" />
          ) : (
            <ImageIcon size={32} className="text-muted-foreground" />
          )
        ) : isPdf(att.mime_type) ? (
          <FileText size={32} className="text-red-500" />
        ) : (
          <FileText size={32} className="text-blue-500" />
        )}
        <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <Eye size={20} className="text-white" />
        </span>
      </button>

      {/* Metadata */}
      <div className="p-2 space-y-0.5">
        <p className="text-xs font-medium truncate" title={att.filename}>
          {att.filename}
        </p>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{formatSize(att.size_bytes)}</span>
          {att.category && (
            <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary truncate max-w-[80px]">
              {att.category}
            </span>
          )}
        </div>
        {att.description && (
          <p className="text-[10px] text-muted-foreground italic truncate" title={att.description}>
            "{att.description}"
          </p>
        )}
        {canDelete && (
          <button
            onClick={onDelete}
            className="w-full mt-1 text-[10px] text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center gap-1"
            title="Remover"
          >
            <Trash2 size={10} /> Remover
          </button>
        )}
      </div>
    </div>
  );
}
