'use client';

/**
 * NovaAvaliacaoModal — Onda 17.6.
 *
 * Modal acionado pelo card "Nova avaliação" do Menu inicial. Permite:
 *  - Buscar paciente existente por nome/CPF/telefone (debounced)
 *  - Click no resultado leva direto pra ficha do paciente na aba
 *    "Avaliação" (odontogram), pronto pra dar entrada
 *  - Botao "+ Cadastrar novo paciente" como fallback (segue pro mesmo
 *    fluxo do card "Novo paciente")
 *
 * Pq nao um redirect direto pra /pacientes? Pq desse card o operador
 * jah chegou com a intencao de "fazer uma avaliacao agora" — selecionar
 * o paciente eh o atrito minimo necessario. Modal evita perder o
 * contexto da pagina inicial.
 */

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X, UserPlus, Loader2, Activity, Phone } from 'lucide-react';
import api from '@/lib/api';

interface PatientHit {
  id: string;
  name: string | null;
  phone: string | null;
  cpf?: string | null;
  status?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NovaAvaliacaoModal({ open, onClose }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mounted, setMounted] = useState(false);

  // Garante client-only render — createPortal precisa de window
  useEffect(() => setMounted(true), []);

  // Foco automatico ao abrir
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      // Carga inicial: 10 pacientes mais recentes
      fetchPatients('');
    } else {
      setSearch('');
      setHits([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc fecha
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const fetchPatients = async (q: string) => {
    setLoading(true);
    try {
      const r = await api.get('/patients', {
        params: { search: q || undefined, status: 'ACTIVE', limit: 15 },
      });
      const data = Array.isArray(r.data) ? r.data : r.data?.data || [];
      setHits(data);
    } catch {
      setHits([]);
    } finally {
      setLoading(false);
    }
  };

  // Debounce 250ms na busca
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPatients(search.trim());
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, open]);

  const goToPatient = (id: string) => {
    onClose();
    // Aba "Avaliação" = id 'odontogram' (TABS do paciente)
    router.push(`/atendimento/pacientes/${id}?tab=odontogram`);
  };

  const goToNewPatient = () => {
    onClose();
    router.push('/atendimento/pacientes?new=1');
  };

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-4 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
          <div className="w-9 h-9 rounded-lg bg-teal-100 dark:bg-teal-500/15 grid place-items-center">
            <Activity size={18} className="text-teal-600 dark:text-teal-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-foreground">Nova avaliação</h2>
            <p className="text-xs text-muted-foreground truncate">
              Selecione o paciente que vai passar pela avaliação
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent/30 text-muted-foreground transition-colors"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search input */}
        <div className="px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-background border border-border rounded-xl focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary/40">
            <Search size={16} className="text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, CPF ou telefone..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {loading && <Loader2 size={14} className="text-muted-foreground animate-spin shrink-0" />}
          </div>
        </div>

        {/* Lista de resultados */}
        <div className="max-h-[50vh] overflow-y-auto px-2 pb-2">
          {hits.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <Search size={24} className="mx-auto text-muted-foreground/40 mb-2" />
              <p className="text-xs text-muted-foreground">
                {search ? 'Nenhum paciente encontrado pra essa busca' : 'Comece a digitar pra buscar'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {hits.map((p) => (
                <button
                  key={p.id}
                  onClick={() => goToPatient(p.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/20 active:bg-accent/40 transition-colors text-left"
                >
                  <div className="w-9 h-9 rounded-full bg-primary/10 grid place-items-center text-primary font-bold text-sm flex-none">
                    {(p.name || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-foreground truncate">{p.name || 'Sem nome'}</div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-3">
                      {p.phone && (
                        <span className="flex items-center gap-1">
                          <Phone size={9} /> {p.phone}
                        </span>
                      )}
                      {p.cpf && <span>CPF {p.cpf}</span>}
                    </div>
                  </div>
                  <span className="text-[10px] font-semibold text-primary opacity-0 group-hover:opacity-100">
                    Avaliar →
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer com fallback "Cadastrar novo" */}
        <div className="px-5 py-3 border-t border-border bg-accent/5 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Paciente novo?</span>
          <button
            onClick={goToNewPatient}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            <UserPlus size={13} />
            Cadastrar novo paciente
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
