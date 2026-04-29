'use client';

/**
 * ContactPicker — combobox com busca pra selecionar Paciente OU Lead.
 *
 * Substitui o `<select>` simples no formulário de evento da agenda.
 * Carrega pacientes + leads em paralelo, mostra unificados com badge
 * "Paciente" / "Lead" e busca por nome/telefone/CPF conforme o operador
 * digita.
 *
 * Pacientes aparecem PRIMEIRO (são a escolha mais comum em uma clínica
 * já estabelecida) e a primeira letra digitada filtra ambos os grupos.
 *
 * Quando seleciona um Paciente:
 *   - onChange recebe { patient_id, lead_id (se vinculado) }
 * Quando seleciona um Lead:
 *   - onChange recebe { lead_id, patient_id: null }
 * Quando limpa:
 *   - onChange recebe { patient_id: null, lead_id: null }
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, User, ChevronDown, Loader2 } from 'lucide-react';
import api from '@/lib/api';

interface PatientOption {
  id: string;
  name: string | null;
  phone: string | null;
  cpf?: string | null;
  lead_id?: string | null;
  status?: string;
}

interface LeadOption {
  id: string;
  name: string | null;
  phone: string;
}

type ContactKind = 'patient' | 'lead';
interface ContactOption {
  kind: ContactKind;
  id: string;
  name: string;
  phone: string | null;
  cpf?: string | null;
  /** Lead vinculado quando kind=patient */
  linkedLeadId?: string | null;
}

interface Selection {
  patient_id: string | null;
  lead_id: string | null;
}

interface Props {
  value: Selection;
  onChange: (s: Selection) => void;
  /** Cache externo opcional pra evitar refetch ao reabrir o modal */
  patients?: PatientOption[];
  leads?: LeadOption[];
}

export default function ContactPicker({ value, onChange, patients: patientsProp, leads: leadsProp }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [patients, setPatients] = useState<PatientOption[]>(patientsProp || []);
  const [leads, setLeads] = useState<LeadOption[]>(leadsProp || []);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Carrega pacientes + leads na primeira abertura (lazy)
  useEffect(() => {
    if (!open) return;
    if (patients.length > 0 && leads.length > 0) return;
    setLoading(true);
    Promise.all([
      api.get('/patients?limit=200&status=ACTIVE').catch(() => ({ data: { data: [] } })),
      api.get('/leads').catch(() => ({ data: [] })),
    ])
      .then(([pRes, lRes]) => {
        const pData = (pRes.data?.data || pRes.data || []) as any[];
        setPatients(pData.map((p) => ({
          id: p.id,
          name: p.name,
          phone: p.phone,
          cpf: p.cpf,
          lead_id: p.lead_id,
          status: p.status,
        })));
        const lData = (lRes.data || []) as any[];
        setLeads(lData.map((l) => ({ id: l.id, name: l.name, phone: l.phone })));
      })
      .finally(() => {
        setLoading(false);
        // Foca o input após carregar
        setTimeout(() => inputRef.current?.focus(), 50);
      });
  }, [open, patients.length, leads.length]);

  // Fecha popover ao clicar fora
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Encontra a seleção atual pra exibir nome/telefone
  const currentLabel = useMemo(() => {
    if (value.patient_id) {
      const p = patients.find((x) => x.id === value.patient_id);
      if (p) return { kind: 'patient' as const, name: p.name || 'Sem nome', phone: p.phone };
    }
    if (value.lead_id) {
      const l = leads.find((x) => x.id === value.lead_id);
      if (l) return { kind: 'lead' as const, name: l.name || 'Sem nome', phone: l.phone };
      // Fallback: pode ser um lead que ainda não carregamos (modal sendo editado)
      return { kind: 'lead' as const, name: 'Lead vinculado', phone: null };
    }
    return null;
  }, [value, patients, leads]);

  // Unifica patients + leads em uma lista filtrada pela busca
  const options = useMemo<ContactOption[]>(() => {
    const q = search.trim().toLowerCase();
    const matches = (text: string | null | undefined) =>
      !q || (text || '').toLowerCase().includes(q);

    const patientOpts: ContactOption[] = patients
      .filter((p) =>
        matches(p.name) || matches(p.phone || '') || matches(p.cpf || ''),
      )
      .map((p) => ({
        kind: 'patient',
        id: p.id,
        name: p.name || 'Sem nome',
        phone: p.phone,
        cpf: p.cpf,
        linkedLeadId: p.lead_id,
      }));

    // Esconde leads que já viraram paciente (evita duplicata visual)
    const linkedLeadIds = new Set(
      patients.map((p) => p.lead_id).filter(Boolean) as string[],
    );
    const leadOpts: ContactOption[] = leads
      .filter((l) => !linkedLeadIds.has(l.id))
      .filter((l) => matches(l.name) || matches(l.phone))
      .map((l) => ({
        kind: 'lead',
        id: l.id,
        name: l.name || 'Sem nome',
        phone: l.phone,
      }));

    // Pacientes primeiro, leads depois — limita pra não estourar
    return [...patientOpts.slice(0, 50), ...leadOpts.slice(0, 50)];
  }, [patients, leads, search]);

  const handleSelect = (opt: ContactOption) => {
    if (opt.kind === 'patient') {
      onChange({ patient_id: opt.id, lead_id: opt.linkedLeadId || null });
    } else {
      onChange({ patient_id: null, lead_id: opt.id });
    }
    setOpen(false);
    setSearch('');
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange({ patient_id: null, lead_id: null });
    setSearch('');
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-left flex items-center justify-between gap-2 hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        {currentLabel ? (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase shrink-0 ${
              currentLabel.kind === 'patient'
                ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                : 'bg-blue-500/10 text-blue-600 border border-blue-500/20'
            }`}>
              {currentLabel.kind === 'patient' ? 'Paciente' : 'Lead'}
            </span>
            <span className="truncate">{currentLabel.name}</span>
            {currentLabel.phone && (
              <span className="text-xs text-muted-foreground truncate">{currentLabel.phone}</span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">Nenhum — clique pra buscar paciente ou lead</span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          {currentLabel && (
            <span
              role="button"
              onClick={handleClear}
              className="p-0.5 rounded hover:bg-accent"
              title="Limpar"
            >
              <X size={14} />
            </span>
          )}
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-2xl overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome, telefone ou CPF..."
                className="w-full pl-7 pr-2 py-1.5 rounded bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                <Loader2 size={14} className="inline animate-spin mr-1" /> Carregando...
              </div>
            ) : options.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {search.trim()
                  ? `Nenhum paciente ou lead corresponde a "${search}".`
                  : 'Nenhum contato disponível.'}
              </div>
            ) : (
              <ul className="py-1">
                {options.map((opt) => (
                  <li
                    key={`${opt.kind}-${opt.id}`}
                    onClick={() => handleSelect(opt)}
                    className="px-3 py-2 hover:bg-accent cursor-pointer text-sm flex items-center gap-2"
                  >
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      opt.kind === 'patient'
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : 'bg-blue-500/10 text-blue-600'
                    }`}>
                      {opt.name.split(' ').slice(0, 2).map((n) => n[0]?.toUpperCase()).join('') || <User size={12} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate">{opt.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase shrink-0 ${
                          opt.kind === 'patient'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : 'bg-blue-500/10 text-blue-600'
                        }`}>
                          {opt.kind === 'patient' ? 'Paciente' : 'Lead'}
                        </span>
                      </div>
                      {(opt.phone || opt.cpf) && (
                        <div className="text-xs text-muted-foreground truncate">
                          {opt.phone}{opt.phone && opt.cpf ? ' · ' : ''}{opt.cpf ? `CPF ${opt.cpf}` : ''}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!loading && options.length > 0 && (
            <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground bg-background/50">
              Mostrando {options.length} resultado(s){search.trim() ? '' : ' — digite pra filtrar'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
