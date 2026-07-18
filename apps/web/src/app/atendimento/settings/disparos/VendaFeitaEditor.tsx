'use client';

// Editor do disparo "Equipe → Venda feita". Não é uma mensagem editável (é um
// aviso automático montado da venda), então aqui configura-se só QUEM recebe.
// Ligar/desligar fica no toggle do card.
import { useEffect, useState } from 'react';
import { Loader2, Save, PartyPopper } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

export function VendaFeitaEditor() {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<{ phone: string }>('/followup/venda-feita-config')
      .then((r) => { if (!cancelled) setPhone(r.data?.phone || ''); })
      .catch((e: any) => { if (!cancelled) showError(e?.response?.data?.message || 'Erro ao carregar a configuração'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/followup/venda-feita-config', { phone: phone.trim() });
      setPhone(r.data?.phone || '');
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
          <PartyPopper size={18} className="text-emerald-500" /> Venda feita
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          A cada venda fechada — na <b>venda rápida</b> ou no <b>aprovar-e-cobrar</b> — um aviso é enviado ao número
          configurado (pelo chip do Financeiro, com fallback pra Clínica): <b>paciente</b>, <b>valor</b>, <b>forma de
          pagamento</b>, <b>itens</b> e <b>quem vendeu</b>. Ligue o disparo no botão do card pra começar.
        </p>
      </div>

      <div className="rounded-xl border border-border p-4 space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground">Número que recebe o aviso</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="5582999998888 (com o 55)"
            className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="text-[11px] text-muted-foreground mt-1">DDD + número, com o código do país (55). Ex.: 5582999998888.</p>
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
