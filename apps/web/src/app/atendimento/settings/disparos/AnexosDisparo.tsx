'use client';

// Anexos (fotos/áudio) de UM disparo automático — vai no editor do card, antes do teste.
// O motor do disparo manda o texto como sempre e, se ele saiu, manda estes anexos logo
// depois (fotos, depois áudio), pelo mesmo chip. Só ADMIN altera.
import { useEffect, useRef, useState } from 'react';
import { Film, ImageIcon, Loader2, Mic, Paperclip, Plus, X } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { DISPARO_ANEXO_LIMITE_BYTES, DISPARO_ANEXO_MAX } from '@crm/shared';

interface Anexo { id: string; kind: 'image' | 'audio' | 'video'; mime_type: string; size: number; original_name: string | null; position: number }

const mb = (b: number) => `${Math.round(b / 1024 / 1024)} MB`;

export function AnexosDisparo({ disparo, podeEditar }: { disparo: string; podeEditar: boolean }) {
  const [anexos, setAnexos] = useState<Anexo[] | null>(null);
  const [enviando, setEnviando] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let vivo = true;
    setAnexos(null);
    api.get<Anexo[]>(`/disparos/${disparo}/anexos`)
      .then((r) => { if (vivo) setAnexos(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (vivo) setAnexos([]); });
    return () => { vivo = false; };
  }, [disparo]);

  const anexar = async (files: FileList | null) => {
    if (!files?.length || !anexos) return;
    setEnviando(true);
    let lista = anexos;
    try {
      for (const f of Array.from(files)) {
        if (lista.length >= DISPARO_ANEXO_MAX) { showError(`Máximo de ${DISPARO_ANEXO_MAX} anexos por disparo`); break; }
        const fd = new FormData();
        fd.append('file', f);
        const r = await api.post<Anexo>(`/disparos/${disparo}/anexos`, fd, { timeout: 120000 });
        lista = [...lista, r.data];
        setAnexos(lista);
      }
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao anexar');
    } finally {
      setEnviando(false);
      if (input.current) input.current.value = '';
    }
  };

  const remover = async (id: string) => {
    try {
      await api.delete(`/disparos/${disparo}/anexos/${id}`);
      setAnexos((l) => (l || []).filter((a) => a.id !== id));
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao remover');
    }
  };

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden mt-4">
      <div className="border-b border-border px-5 py-3 flex items-center gap-2">
        <Paperclip size={15} className="text-primary" />
        <h3 className="text-sm font-bold">Fotos, vídeo e áudio deste disparo</h3>
        <span className="text-[10px] text-muted-foreground ml-auto">opcional · até {DISPARO_ANEXO_MAX}</span>
      </div>
      <div className="p-5 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          Saem logo depois da mensagem, pelo mesmo chip (fotos e vídeos primeiro, áudio por último, como mensagem de voz). O texto
          continua igual; se um anexo falhar, a mensagem não é reenviada.
        </p>
        {anexos === null ? (
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        ) : (
          <div className="flex gap-3 flex-wrap">
            {anexos.map((a) => <Miniatura key={a.id} disparo={disparo} a={a} onRemover={podeEditar ? () => remover(a.id) : undefined} />)}
            {podeEditar && anexos.length < DISPARO_ANEXO_MAX && (
              <button type="button" onClick={() => input.current?.click()} disabled={enviando}
                className="w-28 h-28 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground hover:bg-accent/40 disabled:opacity-50">
                {enviando ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                Foto, vídeo ou áudio
              </button>
            )}
            {!podeEditar && anexos.length === 0 && <span className="text-[12px] text-muted-foreground">Nenhum anexo.</span>}
          </div>
        )}
        <input ref={input} type="file" multiple className="hidden"
          accept="image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/ogg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/webm"
          onChange={(e) => anexar(e.target.files)} />
        <p className="text-[10px] text-muted-foreground">
          Fotos JPG/PNG/WEBP até {mb(DISPARO_ANEXO_LIMITE_BYTES.image)} · vídeo MP4 até {mb(DISPARO_ANEXO_LIMITE_BYTES.video)} (o .MOV do iPhone: compartilhe como MP4) · áudio MP3/OGG/M4A/WAV até {mb(DISPARO_ANEXO_LIMITE_BYTES.audio)}.
          O “Enviar teste” abaixo manda a mensagem com os anexos.
        </p>
      </div>
    </div>
  );
}

function Miniatura({ disparo, a, onRemover }: { disparo: string; a: Anexo; onRemover?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    let criada: string | null = null;
    api.get(`/disparos/${disparo}/anexos/${a.id}/arquivo`, { responseType: 'blob' })
      .then((r) => { if (vivo) { criada = URL.createObjectURL(r.data); setUrl(criada); } })
      .catch(() => {});
    return () => { vivo = false; if (criada) URL.revokeObjectURL(criada); };
  }, [disparo, a.id]);
  return (
    <div className="relative w-28 h-28 rounded-xl border border-border overflow-hidden bg-muted/30 flex items-center justify-center">
      {a.kind === 'video'
        ? (url ? <video src={url} controls muted playsInline className="w-full h-full object-cover bg-black" /> : <Film size={20} className="text-muted-foreground" />)
        : a.kind === 'image'
        ? (url ? <img src={url} alt={a.original_name || 'foto'} className="w-full h-full object-cover" /> : <ImageIcon size={20} className="text-muted-foreground" />)
        : (
          <div className="flex flex-col items-center gap-1 px-2 w-full">
            <Mic size={20} className="text-primary" />
            <span className="text-[10px] text-muted-foreground truncate w-full text-center">{a.original_name || 'áudio'}</span>
            {url && <audio src={url} controls className="w-full h-7" />}
          </div>
        )}
      {onRemover && (
        <button type="button" onClick={onRemover} title="Remover"
          className="absolute top-1 right-1 w-6 h-6 rounded-full bg-background/90 border border-border flex items-center justify-center hover:bg-red-500 hover:text-white">
          <X size={12} />
        </button>
      )}
    </div>
  );
}
