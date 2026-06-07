'use client';

/**
 * Onda 17.32.112 — Anamnese MASTER (SUPER_ADMIN only).
 *
 * Singleton — controlado pelo SUPER_ADMIN do SaaS. Quando salva,
 * propaga em TODOS os tenants ativos automaticamente.
 *
 * MVP: editor JSON (textarea). Numa proxima onda, editor visual
 * (drag-and-drop de secoes/perguntas, preview lateral). Por enquanto
 * o JSON ja resolve o caso de uso.
 */
import { useEffect, useState } from 'react';
import {
  ClipboardList, Save, Loader2, AlertCircle, CheckCircle2, ArrowLeft, Eye, EyeOff,
} from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface MasterTemplate {
  id: number;
  version: number;
  schema: any;
  notes: string | null;
  updated_by_user_id: string | null;
  updated_at: string;
}

export default function AnamneseMasterPage() {
  const [master, setMaster] = useState<MasterTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [schemaText, setSchemaText] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<MasterTemplate>('/global-anamnesis');
      setMaster(res.data);
      setSchemaText(JSON.stringify(res.data.schema, null, 2));
    } catch (err: any) {
      const status = err?.response?.status;
      setLoadError(
        status === 401 ? 'Sessão expirou. Faça login novamente.' :
        status === 403 ? 'Você precisa ser SUPER_ADMIN.' :
        'Não foi possível carregar a anamnese master.'
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Valida JSON em tempo real
  useEffect(() => {
    if (!schemaText.trim()) return setParseError(null);
    try {
      const parsed = JSON.parse(schemaText);
      if (!parsed.sections || !Array.isArray(parsed.sections)) {
        setParseError('Schema precisa ter array "sections" no topo.');
      } else {
        setParseError(null);
      }
    } catch (err: any) {
      setParseError(`JSON inválido: ${err.message}`);
    }
  }, [schemaText]);

  const handleSave = async () => {
    if (parseError) {
      showError(parseError);
      return;
    }
    let schema: any;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      showError('JSON inválido');
      return;
    }
    const ok = window.confirm(
      'Salvar anamnese master?\n\n' +
      'Isso vai PROPAGAR a ficha pra TODOS os tenants ativos do sistema.\n' +
      'Cada tenant terá sua ficha sobrescrita pela nova versão.\n\n' +
      'Continuar?'
    );
    if (!ok) return;

    setSaving(true);
    try {
      const res = await api.put<{
        master: MasterTemplate;
        propagated: number;
        failed: number;
        total_tenants: number;
      }>('/global-anamnesis', { schema });
      const { propagated, failed, total_tenants } = res.data;
      if (failed === 0) {
        showSuccess(`Salvo. Propagado em ${propagated} de ${total_tenants} tenants.`);
      } else {
        showError(`Salvo, mas ${failed} de ${total_tenants} tenants falharam. Veja DevTools.`);
      }
      // Recarrega pra refletir nova versão
      await load();
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro ao salvar';
      showError(typeof msg === 'string' ? msg : 'Erro');
    } finally {
      setSaving(false);
    }
  };

  // Conta seções/perguntas pra preview
  const parsedSchema = (() => {
    try { return JSON.parse(schemaText); } catch { return null; }
  })();
  const totalSections = parsedSchema?.sections?.length ?? 0;
  const totalQuestions = parsedSchema?.sections?.reduce(
    (sum: number, s: any) => sum + (s.questions?.length ?? 0), 0,
  ) ?? 0;

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <Link
          href="/admin/tenants"
          className="inline-flex items-center gap-1 text-xs font-bold text-muted-foreground hover:text-violet-700 transition-colors mb-3"
        >
          <ArrowLeft size={12} />
          Admin SaaS
        </Link>
        <h1 className="text-2xl font-extrabold text-foreground tracking-tight flex items-center gap-2">
          <ClipboardList size={22} className="text-violet-600" />
          Anamnese Master
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Ficha única do SaaS. Quando você salva, é propagada pra todos os tenants ativos —
          cada clínica passa a usar essa versão. Tenants não podem editar localmente.
        </p>
      </div>

      {loadError && (
        <div className="mb-5 flex items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl">
          <AlertCircle size={16} className="text-red-700 shrink-0" />
          <p className="text-sm font-semibold text-red-900 dark:text-red-300 flex-1">{loadError}</p>
          <button
            type="button"
            onClick={load}
            className="text-xs font-bold px-3 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-900 dark:text-red-200"
          >
            Tentar de novo
          </button>
        </div>
      )}

      {/* Stats da master */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="Versão" value={`v${master?.version ?? '?'}`} />
        <Stat label="Seções" value={String(totalSections)} />
        <Stat label="Perguntas" value={String(totalQuestions)} />
        <Stat
          label="Atualizado"
          value={master?.updated_at ? new Date(master.updated_at).toLocaleDateString('pt-BR') : '—'}
        />
      </div>

      {/* Aviso de propagação */}
      <div className="mb-5 flex items-start gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
        <AlertCircle size={16} className="text-amber-700 mt-0.5 shrink-0" />
        <p className="text-sm text-amber-900 dark:text-amber-300">
          <strong>Atenção:</strong> ao clicar Salvar, a ficha é sobrescrita em todos os tenants
          ativos. Mudanças que cada clínica tenha feito localmente serão perdidas.
        </p>
      </div>

      {/* Editor */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden mb-4">
        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between bg-muted/30">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Schema JSON (sections + questions)
          </span>
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview)}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-violet-700 hover:underline"
          >
            {showPreview ? <EyeOff size={12} /> : <Eye size={12} />}
            {showPreview ? 'Ocultar' : 'Ver'} preview das seções
          </button>
        </div>

        <textarea
          value={schemaText}
          onChange={(e) => setSchemaText(e.target.value)}
          spellCheck={false}
          rows={24}
          className="w-full font-mono text-xs p-4 bg-background border-0 outline-none resize-y"
          style={{ tabSize: 2 }}
          placeholder='{ "sections": [ ... ] }'
        />

        {parseError && (
          <div className="px-4 py-2 bg-red-500/10 border-t border-red-500/20 text-xs text-red-700 font-medium">
            ⚠ {parseError}
          </div>
        )}
      </div>

      {/* Preview das seções */}
      {showPreview && parsedSchema?.sections && (
        <div className="bg-card border border-border rounded-2xl p-5 mb-4 space-y-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-3">
            Preview das seções
          </p>
          {parsedSchema.sections.map((s: any, i: number) => (
            <div key={s.id ?? i} className="flex items-start gap-3 p-3 rounded-xl bg-muted/30">
              <span className="w-6 h-6 rounded-full bg-violet-600/10 border border-violet-500/20 text-violet-700 text-[11px] font-bold flex items-center justify-center shrink-0">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-foreground">{s.title || '(sem título)'}</p>
                <p className="text-[11px] text-muted-foreground">
                  {s.questions?.length ?? 0} perguntas
                  {s.show_if && <> · condicional ({s.show_if.question_id} = {s.show_if.equals})</>}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* CTA */}
      <div className="flex items-center justify-between sticky bottom-0 bg-background/95 backdrop-blur-sm py-3 -mx-2 px-2 border-t border-border">
        <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
          <CheckCircle2 size={11} className="text-emerald-600" />
          Propagação automática pra todos os tenants
        </p>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !!parseError}
          className="text-sm font-bold px-5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-[0_4px_12px_-2px_rgba(124,58,237,0.4)]"
        >
          {saving ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Salvando e propagando…
            </>
          ) : (
            <>
              <Save size={14} />
              Salvar e propagar pra todos
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-extrabold text-foreground">{value}</p>
    </div>
  );
}
