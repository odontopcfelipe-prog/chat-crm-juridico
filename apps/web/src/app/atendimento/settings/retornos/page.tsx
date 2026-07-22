'use client';

/**
 * Configurações → Retornos.
 *
 * OPT-IN: o admin LIGA o retorno de manutenção só nos procedimentos que precisam
 * (limpeza, profilaxia, controles), e define em quantos meses. Os demais (biópsia,
 * exodontia, raio-x, avaliação...) NÃO geram retorno. Também define o PADRÃO da clínica —
 * o tempo sugerido ao ligar um procedimento, e usado no retorno de "Tratamento Concluído".
 *
 * Ao salvar, o quadro "Retornos (Manutenção)" reorganiza SOZINHO no próximo acesso: o
 * retorno por procedimento é calculado ao vivo a partir daqui (sem backfill).
 *
 * Semântica de Procedure.default_revisit_months:
 *   - null / 0 → NÃO gera retorno (desligado)
 *   - >= 1     → gera retorno N meses após o atendimento (ligado)
 */
import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Loader2, Search, Save } from 'lucide-react';
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

/** Liga/desliga o retorno do procedimento; quando ligado, edita os meses. */
function RecallControl({
  value,
  suggested,
  onChange,
}: {
  value: number | null;
  suggested: number;
  onChange: (v: number | null) => void;
}) {
  const on = (value ?? 0) >= 1;
  // Texto local do input: desacopla a digitação do valor salvo pra o campo não SUMIR
  // quando o usuário apaga pra redigitar (ex.: limpar "6" antes de digitar "12").
  const [text, setText] = useState(on ? String(value) : '');
  useEffect(() => {
    setText(on ? String(value) : '');
  }, [on, value]);

  return (
    <div className="flex items-center gap-2.5 shrink-0">
      {on && (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={120}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const s = e.target.value.trim();
              if (s === '') return; // vazio durante a edição não desliga — espera um número
              onChange(clampMonths(Number(s), 1));
            }}
            onBlur={() => {
              if (text.trim() === '') setText(String(value ?? suggested));
            }}
            className="w-16 px-2 py-1.5 text-sm text-right border border-border rounded-md bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <span className="text-xs text-muted-foreground w-9">meses</span>
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(on ? null : suggested)}
        title={on ? 'Desligar retorno deste procedimento' : 'Ligar retorno deste procedimento'}
        className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
          on ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
            on ? 'translate-x-4' : ''
          }`}
        />
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

  // "ligado" = valor >= 1. Trata null e 0 como desligado (ambos = sem retorno no board).
  const isOn = (v: number | null | undefined) => (v ?? 0) >= 1;
  const dirtyIds = useMemo(
    () =>
      procs
        .filter((p) => {
          const a = drafts[p.id] ?? null;
          const b = orig[p.id] ?? null;
          // null e 0 são equivalentes (desligado): não marca dirty entre eles.
          if (!isOn(a) && !isOn(b)) return false;
          return a !== b;
        })
        .map((p) => p.id),
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

  const activeCount = useMemo(
    () => procs.filter((p) => isOn(drafts[p.id])).length,
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
          // desligado → null (sem retorno); ligado → N meses
          api.patch(`/procedures/${id}`, { default_revisit_months: isOn(drafts[id]) ? drafts[id] : null }),
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
              Ligue o retorno de manutenção só nos procedimentos que precisam e defina o tempo. Ao
              salvar, o quadro <strong>Retornos (Manutenção)</strong> se reorganiza sozinho.
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
                Retorno padrão
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Tempo sugerido ao <strong>ligar</strong> um procedimento — e usado no retorno de{' '}
                <strong>Tratamento Concluído</strong>.
              </p>
              <div className="flex items-center flex-wrap gap-2 mt-3">
                <span className="text-sm text-muted-foreground">Retorno em</span>
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

            {/* Procedimentos com retorno */}
            <div className="bg-card border border-border rounded-2xl p-5">
              <div className="flex items-center justify-between gap-3 mb-1">
                <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                  Procedimentos com retorno
                </h2>
                <span className="text-[11px] text-muted-foreground">
                  {activeCount} {activeCount === 1 ? 'ligado' : 'ligados'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Ligue o retorno só nos que precisam — limpeza, profilaxia, controles ortodônticos. Os
                demais não geram retorno.
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
                          const on = isOn(v);
                          return (
                            <div
                              key={p.id}
                              className="flex items-center justify-between gap-3 px-3 py-2.5"
                            >
                              <div className="min-w-0">
                                <p
                                  className={`text-sm truncate ${on ? 'text-foreground font-medium' : 'text-foreground'}`}
                                >
                                  {p.name}
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  {on
                                    ? `retorno ${v} ${v === 1 ? 'mês' : 'meses'} após o atendimento`
                                    : 'sem retorno'}
                                </p>
                              </div>
                              <RecallControl
                                value={v}
                                suggested={defaultMonths}
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
