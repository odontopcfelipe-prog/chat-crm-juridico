'use client';

// Onda 17.59 — editor GENÉRICO de mensagem de disparo. Mesmo padrão do
// ConfirmacaoEditor (variáveis + preview + salvar), mas parametrizado por
// endpoint/título/variáveis — pra qualquer disparo de template (re-agendamento,
// aniversário, etc.) poder ver/editar a mensagem. O liga/desliga fica no toggle
// da linha; aqui edita-se só o TEXTO.
import { useEffect, useState } from 'react';
import { Loader2, Save, MessageSquare, Eye, Variable } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { formatClinicAddress } from '@/lib/utils';

export interface MensagemEditorProps {
  titulo: string;
  descricao: string;
  /** GET → { template } e PUT { template } → { template } */
  endpoint: string;
  variaveis: { key: string; desc: string }[];
  /** Valores de exemplo pro preview, por chave de variável. */
  preview: Record<string, string>;
  /** Se true, busca o endereço real da clínica pra {local_line}/{local}. */
  usaLocal?: boolean;
  maxLen?: number;
  /** Onda 17.59 — reporta o texto ATUAL pro "Enviar teste" mandar o que está na
   *  tela, sem precisar salvar antes. */
  onCurrentTextChange?: (text: string) => void;
  /** Onda 18.18 — texto-padrão de fallback: se o backend devolver vazio ou falhar
   *  (ex.: API ainda subindo), mostra ESTE no lugar de um textarea em branco. */
  defaultText?: string;
}

function applyPreview(t: string, vars: Record<string, string>, local: string): string {
  const localLine = local ? `📍 ${local}\n` : '';
  return (t || '')
    .replace(/\{local_line\}/g, localLine)
    .replace(/\{(\w+)\}/g, (_m, k) => (k === 'local' ? local : vars[k] ?? ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function MensagemEditor({ titulo, descricao, endpoint, variaveis, preview, usaLocal, maxLen = 1500, onCurrentTextChange, defaultText }: MensagemEditorProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState('');
  const [clinicAddress, setClinicAddress] = useState(usaLocal ? 'Rua das Acácias, 123 — Sala 4 (exemplo)' : '');

  // Onda 17.59 — reporta o texto atual pro "Enviar teste" testar o que está na tela.
  useEffect(() => { onCurrentTextChange?.(template); }, [template, onCurrentTextChange]);

  useEffect(() => {
    // Onda 18.24 — quando há texto padrão (ex.: cobrança), usa timeout CURTO: se a
    // API estiver lenta/reiniciando, cai no padrão em 8s em vez de girar até 120s
    // (o default do axios). Editores SEM padrão mantêm o timeout longo pra não
    // perder texto customizado durante um restart.
    api.get(endpoint, defaultText ? { timeout: 8000 } : undefined)
      .then((r) => setTemplate(r.data?.template || defaultText || ''))
      .catch((e: any) => {
        if (defaultText) setTemplate(defaultText); // API lenta/subindo: mostra o padrão
        else showError(e?.response?.data?.message || 'Falha ao carregar a mensagem');
      })
      .finally(() => setLoading(false));
    if (usaLocal) {
      api.get('/tenants/me')
        .then((r) => { const a = formatClinicAddress(r.data); if (a) setClinicAddress(a); })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put(endpoint, { template });
      if (r.data?.template != null) setTemplate(r.data.template);
      showSuccess('Mensagem salva');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="border-b border-border px-5 py-4 flex items-center gap-2">
        <MessageSquare size={16} className="text-primary" />
        <h2 className="text-base font-bold">{titulo}</h2>
      </div>
      <div className="p-5 space-y-4">
        <p className="text-[11px] text-muted-foreground">{descricao}</p>

        <div className="p-3 rounded-xl bg-muted/30 border border-border">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
            <Variable size={11} /> Variáveis disponíveis
          </div>
          {/* Onda 17.59 — significado VISÍVEL de cada variável (não só no hover). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            {variaveis.map((v) => (
              <div key={v.key} className="flex items-baseline gap-1.5 text-[11px]">
                <code className="font-mono text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded whitespace-nowrap">
                  {`{${v.key}}`}
                </code>
                <span className="text-muted-foreground leading-tight">{v.desc}</span>
              </div>
            ))}
          </div>
          {usaLocal && (
            <p className="text-[10px] text-muted-foreground mt-2 italic">
              💡 Use <code className="bg-muted/50 px-1 rounded">{'{local_line}'}</code> em vez de{' '}
              <code>{'{local}'}</code> — já adiciona o 📍 e a quebra de linha.
            </p>
          )}
        </div>

        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={5}
          maxLength={maxLen}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
          placeholder="Texto da mensagem com variáveis…"
        />
        <div className="text-[10px] text-muted-foreground">{template.length}/{maxLen} caracteres</div>

        <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
            <Eye size={11} /> Preview (como o paciente vai receber)
          </div>
          <div className="text-xs text-foreground whitespace-pre-wrap">
            {applyPreview(template, preview, clinicAddress) || <em className="text-muted-foreground">(mensagem vazia)</em>}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
