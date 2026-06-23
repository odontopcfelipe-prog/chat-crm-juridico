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
import { createPortal } from 'react-dom';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Onda 17.61 — popover em PORTAL (position:fixed) pra escapar do overflow do modal
  // (que cortava a lista). pos = ancoragem calculada a partir do trigger.
  const [pos, setPos] = useState<{ top: number; left: number; width: number; listMaxHeight: number } | null>(null);

  // v31: carrega pacientes + leads na primeira abertura (lazy).
  // Bug resolvido: filtro status=ACTIVE excluia pacientes recem-cadastrados
  // (que ficam com status null no Brasil). Removido filtro — backend
  // retorna todos do tenant. ARQUIVADOS sao excluidos client-side abaixo.
  useEffect(() => {
    if (!open) return;
    if (patients.length > 0 && leads.length > 0) return;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      // Sem filtro status — pega todos pacientes ATIVOS do tenant
      api.get('/patients?limit=500').catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[ContactPicker] Falha ao carregar pacientes:', e?.response?.status, e?.response?.data);
        return { __error: e?.response?.data?.message || e?.message || 'erro ao carregar pacientes', data: { data: [] } } as any;
      }),
      api.get('/leads?limit=500').catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[ContactPicker] Falha ao carregar leads:', e?.response?.status, e?.response?.data);
        return { __error: e?.response?.data?.message || e?.message || 'erro ao carregar leads', data: [] } as any;
      }),
    ])
      .then(([pRes, lRes]) => {
        // Captura erro pra mostrar no UI (sem engolir mais)
        if ((pRes as any).__error || (lRes as any).__error) {
          setLoadError((pRes as any).__error || (lRes as any).__error);
        }
        // Aceita formatos: { data: [...] }, { data: { data: [...] } }, [...]
        const pData = Array.isArray(pRes.data)
          ? pRes.data
          : (pRes.data?.data || pRes.data?.patients || []);
        // Filtra ARCHIVED client-side (mantem null/ACTIVE/INACTIVE/etc)
        const filteredPatients = pData
          .filter((p: any) => p.status !== 'ARCHIVED')
          .map((p: any) => ({
            id: p.id,
            name: p.name,
            phone: p.phone,
            cpf: p.cpf,
            lead_id: p.lead_id,
            status: p.status,
          }));
        setPatients(filteredPatients);

        const lData = Array.isArray(lRes.data)
          ? lRes.data
          : (lRes.data?.data || lRes.data?.leads || []);
        setLeads(lData.map((l: any) => ({ id: l.id, name: l.name, phone: l.phone })));

        // eslint-disable-next-line no-console
        console.log(`[ContactPicker] carregado: ${filteredPatients.length} pacientes, ${lData.length} leads`);
      })
      .finally(() => {
        setLoading(false);
        // Foca o input após carregar
        setTimeout(() => inputRef.current?.focus(), 50);
      });
  }, [open, patients.length, leads.length]);

  // Fecha popover ao clicar fora (trigger OU popover portalizado)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (containerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return; // clique dentro do popover (portal)
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Onda 17.61 — posição do popover (portal) ancorada no trigger; recalcula em
  // scroll/resize. Abre pra baixo; se não couber, pra cima. A lista cresce com o espaço.
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const compute = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const M = 8, CHROME = 96; // header de busca + rodapé
      const below = window.innerHeight - r.bottom - M;
      const above = r.top - M;
      const openUp = below < 200 && above > below;
      const space = openUp ? above : below;
      const listMaxHeight = Math.min(380, Math.max(space - CHROME, 140));
      setPos({
        top: openUp ? Math.max(M, r.top - 4 - (listMaxHeight + CHROME)) : r.bottom + 4,
        left: r.left,
        width: r.width,
        listMaxHeight,
      });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  // v32: Bug fix — ContactPicker eh LAZY (carrega lista so ao abrir popover).
  // Quando modal de edicao abre com patient_id ja setado, lista esta vazia
  // e currentLabel nao consegue resolver o nome → mostrava "Nenhum" mesmo
  // o evento tendo paciente. Agora busca individualmente via API se nao
  // achou na lista carregada.
  useEffect(() => {
    // Se tem patient_id mas nao esta na lista, busca individual
    if (value.patient_id && !patients.find((p) => p.id === value.patient_id)) {
      api.get(`/patients/${value.patient_id}`).then((res) => {
        const p = res.data;
        if (p?.id) {
          setPatients((prev) => {
            // Evita duplicar
            if (prev.some((x) => x.id === p.id)) return prev;
            return [...prev, {
              id: p.id, name: p.name, phone: p.phone, cpf: p.cpf,
              lead_id: p.lead_id, status: p.status,
            }];
          });
        }
      }).catch(() => {/* paciente pode ter sido deletado */});
    }
    // Mesma logica pra lead
    if (value.lead_id && !leads.find((l) => l.id === value.lead_id)) {
      api.get(`/leads/${value.lead_id}`).then((res) => {
        const l = res.data;
        if (l?.id) {
          setLeads((prev) => {
            if (prev.some((x) => x.id === l.id)) return prev;
            return [...prev, { id: l.id, name: l.name, phone: l.phone }];
          });
        }
      }).catch(() => {/* lead pode ter sido deletado */});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.patient_id, value.lead_id]);

  // Encontra a seleção atual pra exibir nome/telefone
  const currentLabel = useMemo(() => {
    if (value.patient_id) {
      const p = patients.find((x) => x.id === value.patient_id);
      if (p) return { kind: 'patient' as const, name: p.name || 'Sem nome', phone: p.phone };
      // v32: fallback enquanto fetch individual nao chegou
      return { kind: 'patient' as const, name: 'Carregando paciente...', phone: null };
    }
    if (value.lead_id) {
      const l = leads.find((x) => x.id === value.lead_id);
      if (l) return { kind: 'lead' as const, name: l.name || 'Sem nome', phone: l.phone };
      // Fallback: pode ser um lead que ainda não carregamos (modal sendo editado)
      return { kind: 'lead' as const, name: 'Carregando lead...', phone: null };
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
        ref={triggerRef}
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

      {/* Popover — Onda 17.61: PORTAL (position:fixed) pra não ser cortado pelo overflow do modal */}
      {open && pos && createPortal(
        <div
          ref={popoverRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-card border border-border rounded-lg shadow-2xl overflow-hidden"
        >
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

          {loadError && (
            <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-[11px] text-red-600 dark:text-red-400">
              ⚠️ {loadError} — verifique conexão ou recarregue a página
            </div>
          )}

          <div className="overflow-y-auto" style={{ maxHeight: pos.listMaxHeight }}>
            {loading ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                <Loader2 size={14} className="inline animate-spin mr-1" /> Carregando pacientes e leads...
              </div>
            ) : options.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {search.trim()
                  ? `Nenhum paciente ou lead corresponde a "${search}".`
                  : (loadError
                    ? 'Não foi possível carregar a lista (veja erro acima).'
                    : `Nenhum contato disponível. ${patients.length === 0 && leads.length === 0 ? 'Cadastre pacientes em Pacientes → Novo paciente.' : ''}`)
                }
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
        </div>,
        document.body
      )}
    </div>
  );
}
