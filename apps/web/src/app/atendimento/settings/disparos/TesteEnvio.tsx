'use client';

// Onda 17.56 — teste de entrega compartilhado: aparece em todo editor de disparo.
// Manda a mensagem DAQUELE disparo (com dados de exemplo) pro número informado,
// via /calendar/disparo/send-test. Precisa do WhatsApp da clínica conectado.
import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

export function TesteEnvio({ disparo, text }: { disparo: string; text?: string }) {
  // `phone` guarda só o DDD+número (sem o 55) — o +55 fica FIXO no campo pra nunca
  // ser esquecido (esquecer o 55 = WhatsApp não entrega).
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);

  // Aceita só dígitos; se colar um número já COM o 55 (total > 11 dígitos), tira o
  // 55 da frente pra não virar "5555…". DDD 55 (RS) tem 10–11 dígitos → preservado.
  const onPhoneChange = (raw: string) => {
    let d = raw.replace(/\D/g, '');
    if (d.startsWith('55') && d.length > 11) d = d.slice(2);
    setPhone(d.slice(0, 11));
  };

  const send = async () => {
    setSending(true);
    try {
      // Sempre manda COM o 55 na frente — o campo só tem o DDD+número.
      const fullPhone = `55${phone}`;
      // Onda 17.59 — manda o `text` ATUAL da tela quando o editor fornece (fiel ao
      // que está escrito, mesmo sem salvar). Sem `text`, o backend usa o texto salvo.
      await api.post('/calendar/disparo/send-test', { disparo, phone: fullPhone, text });
      showSuccess('Teste enviado — confira o WhatsApp desse número');
    } catch (e: any) {
      // Onda 18.25 — mostra a CAUSA real em vez de um "falha" genérico, pra dar
      // pra diagnosticar: mensagem do backend > timeout > API fora > status HTTP.
      const backendMsg = e?.response?.data?.message;
      const msg = backendMsg
        || (e?.code === 'ECONNABORTED' ? 'Tempo esgotado — a API demorou a responder (pode estar reiniciando).' : null)
        || (!e?.response ? 'Sem resposta da API — provavelmente fora do ar ou reiniciando. Confira o /api/health e tente de novo.' : null)
        || `Erro ${e?.response?.status ?? ''} ao enviar o teste.`;
      showError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-4 bg-card border border-border rounded-2xl p-4">
      <div className="text-[11px] font-bold text-foreground mb-1.5">🧪 Testar entrega no WhatsApp</div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-[180px] flex items-center bg-background border border-border rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-primary/40">
          <span className="px-2.5 py-2 text-sm font-semibold text-muted-foreground bg-muted/50 border-r border-border select-none whitespace-nowrap">🇧🇷 +55</span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => onPhoneChange(e.target.value)}
            placeholder="DDD + número (ex.: 82999998888)"
            className="flex-1 min-w-0 px-3 py-2 text-sm bg-transparent focus:outline-none"
          />
        </div>
        <button
          onClick={send}
          disabled={sending || phone.length < 10}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold border border-border rounded-lg hover:bg-accent transition-colors disabled:opacity-50"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Enviar teste
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">
        O <b>+55</b> já vai fixo — digite só o DDD + número.{' '}
        {text != null
          ? 'Manda o texto que está NA TELA agora (com dados de exemplo) — não precisa salvar pra testar. Precisa do WhatsApp da clínica conectado.'
          : 'Manda a mensagem deste disparo (com dados de exemplo). Precisa do WhatsApp da clínica conectado.'}
      </p>
    </div>
  );
}
