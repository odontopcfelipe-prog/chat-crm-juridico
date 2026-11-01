'use client';

// F7 do laboratório — editor do texto do lembrete de 48 h ou de 24 h antes da coleta,
// da prova ou da entrega. O texto mora dentro da configuração dos lembretes
// (/calendar/reminders/config), então aqui lê a configuração, troca só o texto da
// faixa aberta e grava de volta só as antecedências do laboratório (48 h e 24 h pelo
// WhatsApp) e os dois textos dele. O liga/desliga fica no card da lista.
// Só a conta de laboratório monta este editor.
import { useEffect, useState } from 'react';
import { Loader2, Save, MessageSquare, Eye, Variable } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { ANTECEDENCIAS_DO_LABORATORIO, chaveDoLembreteDoLaboratorio, LAB_AGENDA_TEXTOS } from '@crm/shared';
import { LAB_EDITORES, LAB_LEMBRETE_EDITOR } from './lab-disparos-textos';

interface Antecedencia { minutes_before: number; channel: string }
interface ConfigDosLembretes {
  enabled?: boolean;
  default_antecedencias?: Antecedencia[];
  templates?: Record<string, string>;
}

const LIMITE = 1500;
const K48 = chaveDoLembreteDoLaboratorio(2880);
const K24 = chaveDoLembreteDoLaboratorio(1440);
const PADRAO: Record<string, string> = { [K48]: LAB_AGENDA_TEXTOS.lembrete48h, [K24]: LAB_AGENDA_TEXTOS.lembrete24h };

/** Mesma troca do preview do MensagemEditor ({local_line} vira a linha do endereço). */
function previa(t: string, vars: Readonly<Record<string, string>>, local: string): string {
  const linhaDoLocal = local ? `📍 ${local}\n` : '';
  return (t || '')
    .replace(/\{local_line\}/g, linhaDoLocal)
    .replace(/\{(\w+)\}/g, (_m, k) => (k === 'local' ? local : vars[k] ?? ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Mensagem do servidor no erro (texto ou lista do ValidationPipe). */
function mensagemDoErro(e: unknown): string | undefined {
  const m = (e as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  if (Array.isArray(m)) return m.join(' ');
  return typeof m === 'string' && m ? m : undefined;
}

/** Só 48 h e 24 h pelo WhatsApp: o servidor do laboratório recusa qualquer outra. */
function antecedenciasDoLaboratorio(lista: Antecedencia[] | undefined): Antecedencia[] {
  return (Array.isArray(lista) ? lista : []).filter(
    (a) => a && a.channel === 'WHATSAPP' && ANTECEDENCIAS_DO_LABORATORIO.includes(Number(a.minutes_before)),
  );
}

export function LabLembreteEditor({ minutos, onCurrentTextChange }: { minutos: number; onCurrentTextChange?: (t: string) => void }) {
  const chave = chaveDoLembreteDoLaboratorio(minutos);
  const textos = chave === K48 ? LAB_EDITORES.lembrete48 : LAB_EDITORES.lembrete24;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<ConfigDosLembretes | null>(null);
  const [template, setTemplate] = useState('');

  useEffect(() => { onCurrentTextChange?.(template); }, [template, onCurrentTextChange]);

  useEffect(() => {
    let vivo = true;
    setLoading(true);
    api.get<ConfigDosLembretes>('/calendar/reminders/config')
      .then((r) => {
        if (!vivo) return;
        // Sem a lista de antecedências não dá pra gravar sem desligar os lembretes.
        setConfig(r.data && Array.isArray(r.data.default_antecedencias) ? r.data : null);
        setTemplate(r.data?.templates?.[chave] || PADRAO[chave]);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setConfig(null);
        setTemplate(PADRAO[chave]);
        showError(mensagemDoErro(e) || LAB_LEMBRETE_EDITOR.falhaAoCarregar);
      })
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, [chave]);

  const save = async () => {
    // Sem a configuração lida, gravar apagaria as antecedências: só salva depois do GET.
    if (!config) return;
    setSaving(true);
    try {
      const atuais = config.templates || {};
      const r = await api.put<ConfigDosLembretes>('/calendar/reminders/config', {
        default_antecedencias: antecedenciasDoLaboratorio(config.default_antecedencias),
        templates: {
          [K48]: atuais[K48] || PADRAO[K48],
          [K24]: atuais[K24] || PADRAO[K24],
          [chave]: template,
        },
      });
      if (r.data && Array.isArray(r.data.default_antecedencias)) {
        setConfig(r.data);
        if (r.data.templates?.[chave] != null) setTemplate(r.data.templates[chave]);
      }
      showSuccess(LAB_LEMBRETE_EDITOR.salvo);
    } catch (e: unknown) {
      showError(mensagemDoErro(e) || LAB_LEMBRETE_EDITOR.falhaAoSalvar);
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
        <h2 className="text-base font-bold">{textos.titulo}</h2>
      </div>
      <div className="p-5 space-y-4">
        <p className="text-[11px] text-muted-foreground">{textos.descricao}</p>

        <div className="p-3 rounded-xl bg-muted/30 border border-border">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
            <Variable size={11} /> {LAB_LEMBRETE_EDITOR.variaveisTitulo}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(textos.variaveis).map(([k, desc]) => (
              <div key={k} className="flex items-baseline gap-1.5 text-[11px]">
                <code className="font-mono text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded whitespace-nowrap">
                  {`{${k}}`}
                </code>
                <span className="text-muted-foreground leading-tight">{desc}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2 italic">💡 {LAB_LEMBRETE_EDITOR.dicaLocal}</p>
        </div>

        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={5}
          maxLength={LIMITE}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
          placeholder={LAB_LEMBRETE_EDITOR.placeholder}
        />
        <div className="text-[10px] text-muted-foreground">{template.length}/{LIMITE} {LAB_LEMBRETE_EDITOR.caracteres}</div>

        <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
            <Eye size={11} /> {textos.previewLabel}
          </div>
          <div className="text-xs text-foreground whitespace-pre-wrap">
            {previa(template, textos.preview, textos.enderecoExemplo) || <em className="text-muted-foreground">{LAB_LEMBRETE_EDITOR.vazia}</em>}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving || !config}
            className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {LAB_LEMBRETE_EDITOR.salvar}
          </button>
        </div>
      </div>
    </div>
  );
}
