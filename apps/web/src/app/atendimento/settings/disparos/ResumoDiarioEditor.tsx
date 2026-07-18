'use client';

// Editor do disparo "Equipe → Resumo diário do dia". Não é uma mensagem editável
// (é um resumo dinâmico dos dados do dia), então aqui configura-se QUEM recebe
// (número) e QUANDO (horário). Ligar/desligar fica no toggle do card.
import { useEffect, useState } from 'react';
import { Loader2, Save, BarChart3 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

export function ResumoDiarioEditor() {
  const [phone, setPhone] = useState('');
  const [time, setTime] = useState('00:00');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<{ phone: string; time: string }>('/followup/daily-summary-config')
      .then((r) => {
        if (cancelled) return;
        setPhone(r.data?.phone || '');
        setTime(r.data?.time || '00:00');
      })
      .catch((e: any) => { if (!cancelled) showError(e?.response?.data?.message || 'Erro ao carregar a configuração'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/followup/daily-summary-config', { phone: phone.trim(), time: time.trim() });
      setPhone(r.data?.phone || '');
      setTime(r.data?.time || '00:00');
      showSuccess('Configuração salva.');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível salvar');
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
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <BarChart3 size={18} className="text-emerald-500" /> Resumo diário do dia
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Todo dia, no horário abaixo, um resumo do dia é enviado ao número configurado (pelo chip do Financeiro,
          com fallback pra Clínica): <b>entradas</b>, <b>saídas</b>, <b>saldo</b>,{' '}
          <b>vendas em boleto (com valores)</b> e <b>negociações fechadas</b>. Ligue o disparo no botão do card pra começar.
        </p>
      </div>

      <div className="rounded-xl border border-border p-4 space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground">Número que recebe o resumo</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="5582999998888 (com o 55)"
            className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="text-[11px] text-muted-foreground mt-1">DDD + número, com o código do país (55). Ex.: 5582999998888.</p>
        </div>

        <div>
          <label className="text-sm font-medium text-foreground">Horário do envio</label>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="mt-1 block w-40 px-3 py-2 rounded-lg border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Padrão <b>00:00</b> — à meia-noite resume o dia que acabou de fechar. Em outro horário, resume o dia corrente até ali.
          </p>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-bold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
