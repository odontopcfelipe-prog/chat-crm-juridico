'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Loader2, User, Phone, IdCard, Plus, DollarSign } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

/**
 * Busca global de paciente — convencao Clinicorp.
 * Atalho: '/' ou Ctrl+K para focar.
 *
 * Suporta busca por nome, CPF, telefone, email. Autocomplete debounce 250ms.
 * Click em resultado leva para /atendimento/pacientes/:id.
 */

interface PatientHit {
  id: string;
  name: string;
  cpf: string | null;
  phone: string | null;
  email: string | null;
}

export function PatientSearch({ className = '' }: { className?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    if (!q || q.length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get<{ data: PatientHit[] }>(
        `/patients?search=${encodeURIComponent(q)}&limit=8`,
      );
      setResults(data?.data || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search
  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => search(query), 250);
    return () => clearTimeout(t);
  }, [query, search]);

  // Atalho global '/' ou Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      const isInputFocused = tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable;

      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Click outside fecha dropdown
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const goto = (id: string) => {
    router.push(`/atendimento/pacientes/${id}`);
    setOpen(false);
    setQuery('');
    setResults([]);
  };

  const newPatient = () => {
    router.push(`/atendimento/pacientes?new=1`);
    setOpen(false);
    setQuery('');
  };

  // Atalho da dra: iniciar orcamento direto. Cria DRAFT (idempotente, reusa
  // se ja existe) e abre a ficha ja na aba Orcamentos com esse quote em edicao.
  const startQuote = async (patientId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // nao dispara o goto do botao pai
    try {
      const { data } = await api.post<{ id: string }>(
        `/patients/${patientId}/quotes/draft-or-create`,
      );
      router.push(`/atendimento/pacientes/${patientId}?tab=quotes&quote=${data.id}`);
      setOpen(false);
      setQuery('');
      setResults([]);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao iniciar orcamento');
    }
  };

  // Navegacao com setas
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, Math.max(0, results.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[highlighted]) goto(results[highlighted].id);
      else if (query.length >= 2) newPatient();
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlighted(0); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Buscar paciente (/, Ctrl+K)"
          className="w-full pl-9 pr-12 py-2 rounded-full bg-card border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
        />
        {loading && (
          <Loader2 size={14} className="absolute right-10 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />
        )}
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-muted-foreground bg-background border border-border rounded px-1.5 py-0.5 pointer-events-none">
          /
        </kbd>
      </div>

      {open && (query.length >= 2 || results.length > 0) && (
        <div className="absolute left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-2xl max-h-96 overflow-y-auto z-50">
          {results.length === 0 && !loading && query.length >= 2 ? (
            <div className="p-4 text-sm text-center">
              <p className="text-muted-foreground mb-2">
                Nenhum paciente encontrado para "<strong>{query}</strong>".
              </p>
              <button
                onClick={newPatient}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Plus size={12} /> Cadastrar novo paciente
              </button>
            </div>
          ) : (
            <ul className="py-1">
              {results.map((p, i) => (
                <li key={p.id}>
                  <div
                    onMouseEnter={() => setHighlighted(i)}
                    className={`group flex items-stretch ${
                      i === highlighted ? 'bg-accent' : 'hover:bg-accent/50'
                    }`}
                  >
                    <button
                      onClick={() => goto(p.id)}
                      className="flex-1 text-left px-3 py-2 flex items-center gap-3 min-w-0"
                    >
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <User size={16} className="text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{p.name}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-3 mt-0.5">
                          {p.cpf && (
                            <span className="flex items-center gap-1">
                              <IdCard size={10} /> {p.cpf}
                            </span>
                          )}
                          {p.phone && (
                            <span className="flex items-center gap-1">
                              <Phone size={10} /> {p.phone}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={(e) => startQuote(p.id, e)}
                      title="Iniciar orcamento (cria rascunho e abre na aba Orcamentos)"
                      className="px-3 flex items-center gap-1 text-xs text-primary hover:bg-primary/10 border-l border-border opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    >
                      <DollarSign size={12} /> Orcar
                    </button>
                  </div>
                </li>
              ))}
              {results.length > 0 && (
                <li className="border-t border-border">
                  <button
                    onClick={newPatient}
                    className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-accent/50 text-xs text-muted-foreground"
                  >
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <Plus size={14} />
                    </div>
                    <span>Cadastrar novo paciente "{query}"</span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
