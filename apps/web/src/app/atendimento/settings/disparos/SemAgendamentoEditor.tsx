'use client';

// Editor do disparo "Equipe → Pacientes sem agendamento". Não é uma mensagem
// editável (é um RESUMO dinâmico montado dos dados reais), então aqui mostramos
// a PRÉVIA do que seria enviado agora + um botão pra ENVIAR TESTE a um número.
import { useEffect, useState } from 'react';
import { Loader2, Send, Users } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Preview { text: string; semAgendar: number; standby: number }

export function SemAgendamentoEditor() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<Preview>('/pacientes-sem-agendamento/preview')
      .then((r) => { if (!cancelled) setPreview(r.data); })
      .catch((e: any) => { if (!cancelled) showError(e?.response?.data?.message || 'Erro ao carregar a prévia'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const sendTest = async () => {
    const p = phone.trim();
    if (!p) { showError('Informe um número pra testar'); return; }
    setSending(true);
    try {
      await api.post('/pacientes-sem-agendamento/test', { phone: p });
      showSuccess('Teste enviado! Confira o WhatsApp.');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Não foi possível enviar o teste');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Users size={18} className="text-violet-500" /> Pacientes sem agendamento
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Resumo interno enviado 1×/dia (8h) aos administradores com telefone cadastrado, pela instância da clínica.
          Junta quem fechou e está +30 dias sem agendar e quem está em stand by. Abaixo, exatamente o que seria enviado agora:
        </p>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-4">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 size={16} className="animate-spin" /> Montando a prévia…
          </div>
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-sm text-foreground m-0">{preview?.text || 'Sem prévia.'}</pre>
        )}
      </div>

      <div className="rounded-xl border border-border p-4 space-y-2">
        <label className="text-sm font-medium text-foreground">Enviar teste pra um número</label>
        <div className="flex gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(82) 99999-9999"
            className="flex-1 px-3 py-2 rounded-lg border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
          <button
            type="button"
            onClick={sendTest}
            disabled={sending}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50 shrink-0"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar teste
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          O teste usa o resumo atual da clínica e sai pela instância da clínica. O número recebe o DDI 55 automaticamente.
        </p>
      </div>
    </div>
  );
}
