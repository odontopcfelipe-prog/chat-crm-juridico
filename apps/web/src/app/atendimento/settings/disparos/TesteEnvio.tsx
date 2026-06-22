'use client';

// Onda 17.56 — teste de entrega compartilhado: aparece em todo editor de disparo.
// Manda a mensagem DAQUELE disparo (com dados de exemplo) pro número informado,
// via /calendar/disparo/send-test. Precisa do WhatsApp da clínica conectado.
import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

export function TesteEnvio({ disparo, text }: { disparo: string; text?: string }) {
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      // Onda 17.59 — manda o `text` ATUAL da tela quando o editor fornece (fiel ao
      // que está escrito, mesmo sem salvar). Sem `text`, o backend usa o texto salvo.
      await api.post('/calendar/disparo/send-test', { disparo, phone, text });
      showSuccess('Teste enviado — confira o WhatsApp desse número');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao enviar o teste');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-4 bg-card border border-border rounded-2xl p-4">
      <div className="text-[11px] font-bold text-foreground mb-1.5">🧪 Testar entrega no WhatsApp</div>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Seu WhatsApp com DDD (ex.: 82999998888)"
          className="flex-1 min-w-[180px] px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
        <button
          onClick={send}
          disabled={sending || !phone.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold border border-border rounded-lg hover:bg-accent transition-colors disabled:opacity-50"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Enviar teste
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">
        {text != null
          ? 'Manda o texto que está NA TELA agora (com dados de exemplo) — você não precisa salvar pra testar. Precisa do WhatsApp da clínica conectado.'
          : 'Manda a mensagem deste disparo (com dados de exemplo) pro número acima. Precisa do WhatsApp da clínica conectado.'}
      </p>
    </div>
  );
}
