'use client';

// Onda 17.61 — editor de UMA das mensagens de aniversário (a Central tem 3 itens
// separados: clássica, o desejo, o presente). Cada item abre este editor com seu
// `which`. O liga/desliga fica na linha da lista; aqui edita-se horário + texto.
import { useEffect, useState } from 'react';
import { Loader2, Save, Cake, Gift, Heart, Eye, Variable, Clock } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

const PREVIEW = { nome: 'Felipe', clinica: 'sua clínica' };

const META: Record<1 | 2 | 3, { titulo: string; sub: string; tplField: string; atField: string; icon: React.ReactNode }> = {
  1: { titulo: 'Mensagem clássica', sub: 'A mensagem tradicional de parabéns', tplField: 'template', atField: 'send_at', icon: <Cake size={16} className="text-fuchsia-500" /> },
  2: { titulo: 'O desejo', sub: 'Na virada do dia (ex.: 00:01) — carinhoso', tplField: 'message2_template', atField: 'message2_send_at', icon: <Heart size={16} className="text-rose-500" /> },
  3: { titulo: 'O presente', sub: 'No meio do dia (ex.: 12:00) — oferta/agrado', tplField: 'message3_template', atField: 'message3_send_at', icon: <Gift size={16} className="text-amber-500" /> },
};

function applyPreview(t: string): string {
  return (t || '')
    .replace(/\{nome\}/g, PREVIEW.nome)
    .replace(/\{clinica\}/g, PREVIEW.clinica)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function AniversarioEditor({ which, onCurrentTextChange }: { which: 1 | 2 | 3; onCurrentTextChange?: (t: string) => void }) {
  const meta = META[which];
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState('');
  const [sendAt, setSendAt] = useState('09:00');

  useEffect(() => {
    api.get('/calendar/birthday-greeting/config')
      .then((r) => {
        setTemplate(r.data?.[meta.tplField] || '');
        setSendAt(r.data?.[meta.atField] || (which === 2 ? '00:00' : which === 3 ? '12:00' : '09:00'));
      })
      .catch((e: any) => showError(e?.response?.data?.message || 'Falha ao carregar a mensagem'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which]);

  useEffect(() => { onCurrentTextChange?.(template); }, [template, onCurrentTextChange]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/calendar/birthday-greeting/config', { [meta.tplField]: template, [meta.atField]: sendAt });
      if (r.data?.[meta.tplField] != null) setTemplate(r.data[meta.tplField]);
      showSuccess('Mensagem salva');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="py-12 flex items-center justify-center text-muted-foreground"><Loader2 size={18} className="animate-spin" /></div>;
  }

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="border-b border-border px-5 py-4 flex items-center gap-2">
        {meta.icon}
        <div>
          <h2 className="text-base font-bold">Aniversário · {meta.titulo}</h2>
          <p className="text-[11px] text-muted-foreground">{meta.sub}</p>
        </div>
      </div>
      <div className="p-5 space-y-4">
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

        <div className="flex items-center gap-2">
          <Clock size={13} className="text-muted-foreground" />
          <span className="text-[11px] font-semibold text-muted-foreground">Horário do disparo</span>
          <input
            type="time"
            value={sendAt}
            onChange={(e) => setSendAt(e.target.value)}
            className="px-2 py-1 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <span className="text-[10px] text-muted-foreground">(fuso de Maceió)</span>
        </div>

        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={7}
          maxLength={2000}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
          placeholder="Texto da mensagem com {nome} e {clinica}…"
        />
        <div className="text-[10px] text-muted-foreground">{template.length}/2000 caracteres</div>

        <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
            <Eye size={11} /> Preview (como o paciente vai receber)
          </div>
          <div className="text-xs text-foreground whitespace-pre-wrap">
            {applyPreview(template) || <em className="text-muted-foreground">(mensagem vazia)</em>}
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
