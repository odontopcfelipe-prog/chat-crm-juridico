'use client';

/**
 * Configurações → Retornos.
 *
 * Onde o admin define, POR PROCEDIMENTO, em quantos meses um atendimento gera um
 * retorno de manutenção do sorriso — e o PADRÃO da clínica pros procedimentos que
 * não têm tempo próprio (e pro retorno de "Tratamento Concluído").
 *
 * Ao salvar, o quadro "Retornos (Manutenção)" reorganiza SOZINHO no próximo acesso:
 * o retorno por procedimento é calculado ao vivo a partir daqui (sem backfill).
 *
 * Semântica do tempo por procedimento:
 *   - vazio  → herda o padrão da clínica
 *   - número → intervalo próprio (meses)
 *   - Nunca  → o procedimento não gera retorno
 */
import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Loader2, Search, Save, Ban } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface ProcCfg {
  id: string;
  name: string;
  default_revisit_months: number | null;
  specialty: { id: string; name: string } | null;
}

const clampMonths = (n: number, min: number) =>
  Math.max(min, Math.min(120, Math.floor(Number.isFinite(n) ? n : min)));

function MonthsControl({
  value,
  defaultMonths,
  onChange,
}: {
  value: number | null;
  defaultMonths: number;
  onChange: (v: number | null) => void;
}) {
  const never = value === 0;
  return (
    <div className="flex items-center gap-2 shrink-0">
      {never ? (
        <span className="text-xs px-2.5 py-1.5 rounded-md bg-muted text-muted-foreground font-semibold">
          Sem retorno
        </span>
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={120}
            value={value ?? ''}
            onChange={(e) => {
              const s = e.target.value.trim();
              if (s === '') return onChange(null);
              onChange(clampMonths(Number(s), 1));
            }}
            placeholder={String(defaultMonths)}
            className="w-16 px-2 py-1.5 text-sm text-right border border-border rounded-md bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <span className="text-xs text-muted-foreground w-9">meses</span>
        </div>
      )}
      <button
        type="button"
        onClick={() => onChange(never ? null : 0)}
        title={never ? 'Voltar a gerar retorno' : 'Este procedimento NÃO gera retorno'}
        className={`p-1.5 rounded-md border transition-colors ${
          never
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground'
        }`}
      >
        <Ban size={13} />
      </button>
    </div>
  );
}

export default function RetornosSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [procs, setProcs] = useState<ProcCfg[]>([]);
  const [drafts, setDrafts] = useState<Record<string, number | null>>({});
  const [defaultMonths, setDefaultMonths] = useState(6);
  const [origDefault, setOrigDefault] = useState(6);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get<{ default_months: number; procedures: ProcCfg[] }>(
        '/return-alerts/config',
      );
      const dm = clampMonths(Number(data?.default_months), 1);
      setDefaultMonths(dm);
      setOrigDefault(dm);
      const list = data?.procedures || [];
      setProcs(list);
      const d: Record<string, number | null> = {};
      for (const p of list) d[p.id] = p.default_revisit_months;
      setDrafts(d);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao carregar configuração de retornos');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const orig = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const p of procs) m[p.id] = p.default_revisit_months;
    return m;
  }, [procs]);

  const dirtyIds = useMemo(
    () => procs.filter((p) => (drafts[p.id] ?? null) !== (orig[p.id] ?? null)).map((p) => p.id),
    [procs, drafts, orig],
  );
  const defaultDirty = defaultMonths !== origDefault;
  const changeCount = dirtyIds.length + (defaultDirty ? 1 : 0);

  const setDraft = (id: string, v: number | null) => setDrafts((d) => ({ ...d, [id]: v }));

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? procs.filter((p) => p.name.toLowerCase().includes(q)) : procs;
    const groups: Record<string, { name: string; items: ProcCfg[] }> = {};
    for (const p of filtered) {
      const key = p.specialty?.id || '__none__';
      const name = p.specialty?.name || 'Sem especialidade';
      if (!groups[key]) groups[key] = { name, items: [] };
      groups[key].items.push(p);
    }
    return Object.entries(groups)
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [procs, search]);

  const configuredCount = useMemo(
    () => procs.filter((p) => (drafts[p.id] ?? null) != null && (drafts[p.id] ?? 0) > 0).length,
    [procs, drafts],
  );

  const handleSave = async () => {
    if (changeCount === 0) return;
    setSaving(true);
    let ok = 0;
    let fail = 0;
    try {
      if (defaultDirty) {
        try {
          await api.patch('/return-alerts/config', { default_months: defaultMonths });
          ok++;
        } catch {
          fail++;
        }
      }
      const results = await Promise.allSettled(
        dirtyIds.map((id) =>
          api.patch(`/procedures/${id}`, { default_revisit_months: drafts[id] }),
        ),
      );
      for (const r of results) r.status === 'fulfilled' ? ok++ : fail++;
      if (fail === 0)
        showSuccess(`Retornos atualizados (${ok}). O quadro reorganiza no próximo acesso.`);
      else showError(`${ok} salvo(s), ${fail} falharam. Tente novamente.`);
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 pb-24">
        {/* Cabeçalho */}
        <div className="mb-5 flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <RotateCcw size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Retornos</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Defina em quanto tempo cada procedimento gera um retorno de manutenção. Ao salvar, o
              quadro <strong>Retornos (Manutenção)</strong> se reorganiza sozinho.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="p-12 flex items-center justify-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
          </div>
        ) : (
          <>
            {/* Padrão da clínica */}
            <div className="bg-card border border-border rounded-2xl p-5 mb-5">
              <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                Padrão da clínica
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Usado quando o procedimento não tem um tempo próprio — e no retorno de{' '}
                <strong>Tratamento Concluído</strong>.
              </p>
              <div className="flex items-center flex-wrap gap-2 mt-3">
                <span className="text-sm text-muted-foreground">Retorno padrão em</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={defaultMonths}
                  onChange={(e) => setDefaultMonths(clampMonths(Number(e.target.value), 1))}
                  className="w-20 px-2.5 py-1.5 text-sm text-center border border-border rounded-md bg-card text-foreground font-semibold focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <span className="text-sm text-muted-foreground">meses após o atendimento</span>
              </div>
            </div>

            {/* Tempo por procedimento */}
            <div className="bg-card border border-border rounded-2xl p-5">
              <div className="flex items-center justify-between gap-3 mb-1">
                <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                  Tempo por procedimento
                </h2>
                <span className="text-[11px] text-muted-foreground">
                  {configuredCount} com tempo próprio
                </span>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Deixe <strong>vazio</strong> para herdar o padrão, defina um número em meses, ou use{' '}
                <Ban size={11} className="inline -mt-0.5" /> para o procedimento{' '}
                <strong>não gerar retorno</strong>.
              </p>

              {/* Busca */}
              <div className="relative mb-3">
                <Search
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar procedimento..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {grouped.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  Nenhum procedimento encontrado.
                </div>
              ) : (
                <div className="space-y-5">
                  {grouped.map((g) => (
                    <div key={g.key}>
                      <p className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-widest mb-1.5">
                        {g.name}
                      </p>
                      <div className="rounded-xl border border-border/60 divide-y divide-border/50">
                        {g.items.map((p) => {
                          const v = drafts[p.id] ?? null;
                          return (
                            <div
                              key={p.id}
                              className="flex items-center justify-between gap-3 px-3 py-2.5"
                            >
                              <div className="min-w-0">
                                <p className="text-sm text-foreground truncate">{p.name}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  {v == null
                                    ? `herda o padrão (${defaultMonths} ${defaultMonths === 1 ? 'mês' : 'meses'})`
                                    : v === 0
                                      ? 'não gera retorno'
                                      : `retorno ${v} ${v === 1 ? 'mês' : 'meses'} após o atendimento`}
                                </p>
                              </div>
                              <MonthsControl
                                value={v}
                                defaultMonths={defaultMonths}
                                onChange={(nv) => setDraft(p.id, nv)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Barra de salvar (fixa no rodapé, só quando há alteração) */}
      {changeCount > 0 && (
        <div className="sticky bottom-0 border-t border-border bg-card/95 backdrop-blur-sm">
          <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {changeCount} {changeCount === 1 ? 'alteração' : 'alterações'} não salva
              {changeCount === 1 ? '' : 's'} · o quadro reorganiza após salvar
            </span>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Salvar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
