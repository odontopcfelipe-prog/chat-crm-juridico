'use client';

/**
 * Configurações → Retornos.
 *
 * O admin ADICIONA só os procedimentos que precisam de revisão/retorno de manutenção
 * (limpeza, profilaxia, controles), e define em quantos meses. A lista mostra SÓ os
 * adicionados — os demais não aparecem nem geram retorno. Também define o PADRÃO da
 * clínica: o tempo usado ao adicionar um procedimento e no retorno de "Tratamento Concluído".
 *
 * Ao salvar, o quadro "Retornos (Manutenção)" reorganiza SOZINHO no próximo acesso: as
 * abas do quadro são exatamente os procedimentos adicionados aqui (calculado ao vivo).
 *
 * Semântica de Procedure.default_revisit_months:
 *   - null / 0 → não está na lista (sem retorno)
 *   - >= 1     → na lista, retorno N meses após o atendimento
 */
import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Loader2, Search, Save, Plus, X } from 'lucide-react';
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

/** Input de meses com texto local — não some quando o usuário apaga pra redigitar. */
function MonthsField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={1}
        max={120}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const s = e.target.value.trim();
          if (s === '') return;
          onChange(clampMonths(Number(s), 1));
        }}
        onBlur={() => {
          if (text.trim() === '') setText(String(value));
        }}
        className="w-16 px-2 py-1.5 text-sm text-right border border-border rounded-md bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
      <span className="text-xs text-muted-foreground w-9">meses</span>
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
  const [adding, setAdding] = useState(false);
  const [addSearch, setAddSearch] = useState('');

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

  // "na lista" = valor >= 1. null e 0 = fora da lista (sem retorno).
  const isOn = (v: number | null | undefined) => (v ?? 0) >= 1;

  const dirtyIds = useMemo(
    () =>
      procs
        .filter((p) => {
          const a = drafts[p.id] ?? null;
          const b = orig[p.id] ?? null;
          if (!isOn(a) && !isOn(b)) return false; // ambos fora → não é mudança
          return a !== b;
        })
        .map((p) => p.id),
    [procs, drafts, orig],
  );
  const defaultDirty = defaultMonths !== origDefault;
  const changeCount = dirtyIds.length + (defaultDirty ? 1 : 0);

  const setDraft = (id: string, v: number | null) => setDrafts((d) => ({ ...d, [id]: v }));

  // Procedimentos JÁ na lista de retorno (ordenados por nome).
  const selected = useMemo(
    () =>
      procs
        .filter((p) => isOn(drafts[p.id]))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    [procs, drafts],
  );

  // Disponíveis pra adicionar (fora da lista) filtrados pela busca.
  const available = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    return procs
      .filter((p) => !isOn(drafts[p.id]))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [procs, drafts, addSearch]);

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
          api.patch(`/procedures/${id}`, {
            default_revisit_months: isOn(drafts[id]) ? drafts[id] : null,
          }),
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
              Adicione os procedimentos que precisam de revisão e defina o tempo. Ao salvar, o
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
            {/* Retorno padrão */}
            <div className="bg-card border border-border rounded-2xl p-5 mb-5">
              <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                Retorno padrão
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Tempo usado ao <strong>adicionar</strong> um procedimento — e no retorno de{' '}
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
                  {selected.length} {selected.length === 1 ? 'na lista' : 'na lista'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Só os que precisam de revisão (limpeza, profilaxia, controles). Os demais não geram
                retorno.
              </p>

              {/* Lista dos adicionados */}
              {selected.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground border border-dashed border-border rounded-xl">
                  Nenhum procedimento com retorno ainda.
                  <br />
                  Clique em <strong>+ Adicionar procedimento</strong> abaixo.
                </div>
              ) : (
                <div className="rounded-xl border border-border/60 divide-y divide-border/50">
                  {selected.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm text-foreground font-medium truncate">{p.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {p.specialty?.name || 'Sem especialidade'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <MonthsField
                          value={drafts[p.id] as number}
                          onChange={(nv) => setDraft(p.id, nv)}
                        />
                        <button
                          type="button"
                          onClick={() => setDraft(p.id, null)}
                          title="Remover da lista de retorno"
                          className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Adicionar */}
              <div className="mt-3">
                {!adding ? (
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(true);
                      setAddSearch('');
                    }}
                    className="w-full py-2.5 rounded-xl border border-dashed border-primary/40 text-primary text-sm font-semibold hover:bg-primary/5 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <Plus size={16} /> Adicionar procedimento
                  </button>
                ) : (
                  <div className="rounded-xl border border-border p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                        Escolher procedimento
                      </span>
                      <button
                        type="button"
                        onClick={() => setAdding(false)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        Fechar
                      </button>
                    </div>
                    <div className="relative mb-2">
                      <Search
                        size={15}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                      />
                      <input
                        autoFocus
                        value={addSearch}
                        onChange={(e) => setAddSearch(e.target.value)}
                        placeholder="Buscar procedimento..."
                        className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>
                    <div className="max-h-72 overflow-y-auto rounded-lg border border-border/60 divide-y divide-border/50">
                      {available.length === 0 ? (
                        <p className="py-6 text-center text-xs text-muted-foreground">
                          {addSearch.trim()
                            ? 'Nenhum procedimento encontrado.'
                            : 'Todos os procedimentos já estão na lista.'}
                        </p>
                      ) : (
                        available.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setDraft(p.id, defaultMonths)}
                            className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent/40 transition-colors"
                          >
                            <div className="min-w-0">
                              <p className="text-sm text-foreground truncate">{p.name}</p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {p.specialty?.name || 'Sem especialidade'}
                              </p>
                            </div>
                            <span className="text-primary text-xs font-semibold flex items-center gap-1 shrink-0">
                              <Plus size={13} /> Adicionar
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
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
