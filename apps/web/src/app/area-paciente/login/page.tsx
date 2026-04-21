'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import portalApi, { setPortalToken } from '@/lib/portalApi';

/**
 * Pagina de login do portal. Aceita ?token=XYZ na URL e faz a troca
 * automaticamente. Se nao tiver token, mostra mensagem orientando
 * paciente a clicar no link enviado por WhatsApp.
 */

function PortalLoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params?.get('token') || '';
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'success'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) return;
    setStatus('loading');
    portalApi.post('/portal/auth/exchange', { token })
      .then(({ data }) => {
        setPortalToken(data.jwt);
        setStatus('success');
        setTimeout(() => router.replace('/area-paciente'), 600);
      })
      .catch((err) => {
        setErrorMsg(err?.response?.data?.message || 'Link invalido ou expirado');
        setStatus('error');
      });
  }, [token, router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-primary/5 to-accent/10">
      <div className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-2xl font-bold mb-4">
            OP
          </div>
          <h1 className="text-xl font-bold">Portal do Paciente</h1>
          <p className="text-sm text-muted-foreground mt-1">Instituto Odonto Passos</p>
        </div>

        <div className="mt-8">
          {status === 'idle' && !token && (
            <div className="text-center text-sm space-y-3">
              <AlertCircle size={32} className="mx-auto text-amber-500" />
              <p className="text-foreground font-medium">Acesso restrito</p>
              <p className="text-muted-foreground text-xs">
                Para entrar, clique no link enviado pela clinica via WhatsApp.
                Se nao recebeu, entre em contato com a recepcao.
              </p>
            </div>
          )}
          {status === 'loading' && (
            <div className="text-center py-6">
              <Loader2 size={32} className="mx-auto text-primary animate-spin" />
              <p className="text-sm text-muted-foreground mt-3">Validando seu acesso...</p>
            </div>
          )}
          {status === 'success' && (
            <div className="text-center py-6">
              <CheckCircle size={32} className="mx-auto text-green-600" />
              <p className="text-sm text-foreground mt-3 font-medium">Bem-vindo(a)!</p>
              <p className="text-xs text-muted-foreground mt-1">Redirecionando...</p>
            </div>
          )}
          {status === 'error' && (
            <div className="text-center py-6">
              <AlertCircle size={32} className="mx-auto text-destructive" />
              <p className="text-sm text-destructive mt-3 font-medium">{errorMsg}</p>
              <p className="text-xs text-muted-foreground mt-2">
                Solicite um novo link a clinica.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { Suspense } from 'react';

export default function PortalLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin" /></div>}>
      <PortalLoginInner />
    </Suspense>
  );
}
