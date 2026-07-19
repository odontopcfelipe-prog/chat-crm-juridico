'use client';

// Editor do disparo "Equipe → Venda feita". Não é uma mensagem editável (é um
// aviso automático montado da venda), então aqui configura-se só QUEM recebe.
// Ligar/desligar fica no toggle do card.
import { useEffect, useState } from 'react';
import { Loader2, Save, PartyPopper, Check } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { Phone55Input } from './Phone55Input';
import { stripCountry55, join55, hasLocalNumber } from './phone55';

export function VendaFeitaEditor() {
  const [local, setLocal] = useState(''); // só DDD + número; o 55 é prefixo fixo
  const [inheritedPhone, setInheritedPhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Está seguindo o número do Resumo Diário? (sem número próprio, mas o resumo tem)
  const inherited = !hasLocalNumber(local) && !!inheritedPhone;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<{ phone: string; inheritedPhone?: string }>('/followup/venda-feita-config')
      .then((r) => {
        if (cancelled) return;
        setLocal(stripCountry55(r.data?.phone));
        setInheritedPhone(r.data?.inheritedPhone || '');
      })
      .catch((e: any) => { if (!cancelled) showError(e?.response?.data?.message || 'Erro ao carregar a configuração'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/followup/venda-feita-config', { phone: join55(local) });
      setLocal(stripCountry55(r.data?.phone));
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
          <Phone55Input local={local} onLocal={setLocal} />
          {inherited ? (
            <p className="text-[12px] text-emerald-600 dark:text-emerald-400 mt-1.5 flex items-start gap-1.5">
              <Check size={14} className="mt-0.5 shrink-0" />
              <span>
                Já está usando o <b>mesmo número do Resumo Diário</b> ({inheritedPhone}). Não precisa preencher — deixe
                em branco que o aviso segue esse contato. Só coloque um número aqui se quiser um <b>diferente</b>.
              </span>
            </p>
          ) : !hasLocalNumber(local) && !inheritedPhone ? (
            <p className="text-[12px] text-amber-600 dark:text-amber-400 mt-1.5">
              Nenhum número configurado — defina um aqui, ou configure o Resumo Diário que este aviso passa a usar o
              mesmo contato automaticamente.
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground mt-1">O <b>55</b> já vem fixo — digite só o <b>DDD + número</b> (ex.: 82999998888).</p>
          )}
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
