'use client';

// Onda 17.61 — editor das DUAS mensagens de aniversário (estratégia "mais humana"):
//   • Mensagem 1 — o desejo, na virada do dia (00:01).
//   • Mensagem 2 — o presente, no meio do dia (12:00).
// Cada uma tem liga/desliga, horário e texto próprios. Salva tudo de uma vez no
// mesmo config (/calendar/birthday-greeting/config).
import { useEffect, useState } from 'react';
import { Loader2, Save, Cake, Gift, Eye, Variable, Clock } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Cfg {
  enabled: boolean;
  send_at: string;
  template: string;
  message2_enabled: boolean;
  message2_send_at: string;
  message2_template: string;
}

const PREVIEW = { nome: 'Felipe', clinica: 'sua clínica' };

function applyPreview(t: string): string {
  return (t || '')
    .replace(/\{nome\}/g, PREVIEW.nome)
    .replace(/\{clinica\}/g, PREVIEW.clinica)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function AniversarioEditor({ onCurrentTextChange }: { onCurrentTextChange?: (t: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<Cfg>({
    enabled: false, send_at: '00:00', template: '',
    message2_enabled: false, message2_send_at: '12:00', message2_template: '',
  });

  useEffect(() => {
    api.get('/calendar/birthday-greeting/config')
      .then((r) => setCfg((c) => ({ ...c, ...r.data })))
      .catch((e: any) => showError(e?.response?.data?.message || 'Falha ao carregar as mensagens'))
      .finally(() => setLoading(false));
  }, []);

  // Reporta o texto da msg 1 pro "Enviar teste".
  useEffect(() => { onCurrentTextChange?.(cfg.template); }, [cfg.template, onCurrentTextChange]);

  const set = (patch: Partial<Cfg>) => setCfg((c) => ({ ...c, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/calendar/birthday-greeting/config', {
        enabled: cfg.enabled, send_at: cfg.send_at, template: cfg.template,
        message2_enabled: cfg.message2_enabled, message2_send_at: cfg.message2_send_at, message2_template: cfg.message2_template,
      });
      setCfg((c) => ({ ...c, ...r.data }));
      showSuccess('Mensagens de aniversário salvas');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="py-12 flex items-center justify-center text-muted-foreground"><Loader2 size={18} className="animate-spin" /></div>;
  }

  const section = (opts: {
    icon: React.ReactNode; titulo: string; sub: string;
    enabled: boolean; onToggle: () => void;
    sendAt: string; onSendAt: (v: string) => void;
    template: string; onTemplate: (v: string) => void;
    accent: string;
  }) => (
    <div className={`rounded-2xl border ${opts.enabled ? opts.accent : 'border-border'} overflow-hidden`}>
      <div className="px-4 py-3 flex items-center gap-2 border-b border-border bg-muted/20">
        {opts.icon}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold truncate">{opts.titulo}</div>
          <div className="text-[10px] text-muted-foreground truncate">{opts.sub}</div>
        </div>
        {/* liga/desliga */}
        <button
          type="button"
          onClick={opts.onToggle}
          className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${opts.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}
          title={opts.enabled ? 'Ativado' : 'Desativado'}
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${opts.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Clock size={13} className="text-muted-foreground" />
          <span className="text-[11px] font-semibold text-muted-foreground">Horário do disparo</span>
          <input
            type="time"
            value={opts.sendAt}
            onChange={(e) => opts.onSendAt(e.target.value)}
            className="px-2 py-1 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
        <textarea
          value={opts.template}
          onChange={(e) => opts.onTemplate(e.target.value)}
          rows={6}
          maxLength={2000}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
          placeholder="Texto da mensagem com {nome} e {clinica}…"
        />
        <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
            <Eye size={11} /> Preview
          </div>
          <div className="text-xs text-foreground whitespace-pre-wrap">
            {applyPreview(opts.template) || <em className="text-muted-foreground">(mensagem vazia)</em>}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="border-b border-border px-5 py-4 flex items-center gap-2">
        <Cake size={16} className="text-fuchsia-500" />
        <h2 className="text-base font-bold">Mensagens de aniversário</h2>
      </div>
      <div className="p-5 space-y-4">
        <p className="text-[11px] text-muted-foreground">
          Duas mensagens no dia do aniversário pra ser mais humano: <b>o desejo</b> na virada do dia
          e <b>o presente</b> no meio da tarde. Ligue/desligue cada uma e ajuste o horário e o texto.
        </p>

        <div className="p-3 rounded-xl bg-muted/30 border border-border">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
            <Variable size={11} /> Variáveis disponíveis
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            <div className="flex items-baseline gap-1.5 text-[11px]">
              <code className="font-mono text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">{'{nome}'}</code>
              <span className="text-muted-foreground">Primeiro nome do paciente</span>
            </div>
            <div className="flex items-baseline gap-1.5 text-[11px]">
              <code className="font-mono text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">{'{clinica}'}</code>
              <span className="text-muted-foreground">Nome da clínica</span>
            </div>
          </div>
        </div>

        {section({
          icon: <Cake size={16} className="text-fuchsia-500 shrink-0" />,
          titulo: 'Mensagem 1 — o desejo',
          sub: 'Na virada do dia (ex.: 00:01)',
          enabled: cfg.enabled,
          onToggle: () => set({ enabled: !cfg.enabled }),
          sendAt: cfg.send_at,
          onSendAt: (v) => set({ send_at: v }),
          template: cfg.template,
          onTemplate: (v) => set({ template: v }),
          accent: 'border-fuchsia-500/40',
        })}

        {section({
          icon: <Gift size={16} className="text-amber-500 shrink-0" />,
          titulo: 'Mensagem 2 — o presente',
          sub: 'No meio do dia (ex.: 12:00) · oferta/agrado',
          enabled: cfg.message2_enabled,
          onToggle: () => set({ message2_enabled: !cfg.message2_enabled }),
          sendAt: cfg.message2_send_at,
          onSendAt: (v) => set({ message2_send_at: v }),
          template: cfg.message2_template,
          onTemplate: (v) => set({ message2_template: v }),
          accent: 'border-amber-500/40',
        })}

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Salvar mensagens
          </button>
        </div>
      </div>
    </div>
  );
}
