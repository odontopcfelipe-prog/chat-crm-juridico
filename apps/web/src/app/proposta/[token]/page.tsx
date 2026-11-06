'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import portalApi from '@/lib/portalApi';
import { LAB_PROPOSTA_PUBLICA as T } from '../lab-proposta-textos';

/**
 * Página pública do orçamento de trabalho (link de aceite do laboratório). Sem login:
 * o token do link só abre o orçamento que o gerou. Mostra o nome do laboratório, os
 * serviços, os totais e as condições, e deixa o cliente aceitar escrevendo o nome.
 * Nada além disso vem da API (sem documento, telefone nem ficha do caso).
 */

type Situacao = 'ABERTO' | 'ACEITO' | 'VENCIDO' | 'ENCERRADO';

interface Servico {
  nome: string | null;
  elemento: string | null;
  quantidade: number;
  unitario: number;
  total: number;
  observacao: string | null;
}

interface Proposta {
  laboratorio: { nome: string; logo: string | null };
  cliente: string | null;
  numero: string;
  situacao: Situacao;
  pode_aceitar: boolean;
  valido_ate: string | null;
  servicos: Servico[];
  subtotal: number;
  desconto_percentual: number;
  desconto: number;
  total: number;
  condicoes: string | null;
  observacoes: string | null;
}

const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
const dataBr = (iso: string) => iso.split('-').reverse().join('/');

export default function PropostaPublicaPage() {
  const params = useParams();
  const token = String(params?.token ?? '');
  const [carregando, setCarregando] = useState(true);
  const [invalido, setInvalido] = useState(false);
  const [proposta, setProposta] = useState<Proposta | null>(null);
  const [nome, setNome] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!token) { setInvalido(true); setCarregando(false); return; }
    let vivo = true;
    portalApi
      .get<Proposta>(`/portal/proposta/${encodeURIComponent(token)}`)
      .then(({ data }) => { if (vivo) setProposta(data); })
      .catch(() => { if (vivo) setInvalido(true); })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [token]);

  useEffect(() => {
    if (proposta) document.title = `${T.tituloDoc(proposta.numero)} · ${proposta.laboratorio.nome}`;
  }, [proposta]);

  const aceitar = async () => {
    if (nome.trim().length < 3) { setErro(T.nomeObrigatorio); return; }
    setEnviando(true);
    setErro('');
    try {
      await portalApi.post(`/portal/proposta/${encodeURIComponent(token)}/aceitar`, { nome: nome.trim() });
      setProposta((p) => (p ? { ...p, situacao: 'ACEITO', pode_aceitar: false } : p));
    } catch (e: any) {
      setErro(e?.response?.data?.message || T.erroAceite);
    } finally {
      setEnviando(false);
    }
  };

  if (carregando) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> {T.carregando}
      </div>
    );
  }

  if (invalido || !proposta) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <AlertCircle size={32} className="mx-auto text-amber-500 mb-3" />
          <p className="font-semibold">{T.linkInvalidoTitulo}</p>
          <p className="text-sm text-muted-foreground mt-1">{T.linkInvalidoTexto}</p>
        </div>
      </div>
    );
  }

  const aviso: Record<Exclude<Situacao, 'ABERTO'>, { titulo: string; texto: string; ok: boolean }> = {
    ACEITO: { titulo: T.aceitoTitulo, texto: T.aceitoTexto, ok: true },
    VENCIDO: { titulo: T.vencidoTitulo, texto: T.vencidoTexto, ok: false },
    ENCERRADO: { titulo: T.encerradoTitulo, texto: T.encerradoTexto, ok: false },
  };
  const fechado = proposta.situacao === 'ABERTO' ? null : aviso[proposta.situacao];
  const primeiroNome = proposta.cliente?.split(' ')[0] || '';

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <header className="flex items-center gap-3">
          {proposta.laboratorio.logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={proposta.laboratorio.logo} alt="" className="h-12 w-12 rounded-lg object-contain bg-card border border-border" />
          )}
          <div className="min-w-0">
            <p className="font-bold leading-tight truncate">{proposta.laboratorio.nome}</p>
            <p className="text-xs text-muted-foreground">{T.tituloDoc(proposta.numero)}</p>
          </div>
        </header>

        {primeiroNome && <h1 className="text-xl font-bold">{T.saudacao(primeiroNome)}</h1>}
        <p className="text-sm text-muted-foreground">{T.introducao}</p>
        {proposta.valido_ate && <p className="text-xs text-muted-foreground">{T.validoAte(dataBr(proposta.valido_ate))}</p>}

        {fechado && (
          <div className={`rounded-xl border p-4 flex gap-3 ${fechado.ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
            {fechado.ok ? <CheckCircle size={20} className="text-emerald-600 shrink-0" /> : <AlertCircle size={20} className="text-amber-600 shrink-0" />}
            <div>
              <p className="font-semibold text-sm">{fechado.titulo}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{fechado.texto}</p>
            </div>
          </div>
        )}

        <section className="bg-card border border-border rounded-xl overflow-hidden">
          <h2 className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">{T.servicos}</h2>
          <ul className="divide-y divide-border">
            {proposta.servicos.map((s, i) => (
              <li key={i} className="px-4 py-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{s.nome || T.colServico}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.elemento ? `${T.elemento(s.elemento)} · ` : ''}{s.quantidade} × {brl(s.unitario)}
                  </p>
                  {s.observacao && <p className="text-xs text-muted-foreground mt-0.5">{s.observacao}</p>}
                </div>
                <p className="text-sm font-semibold shrink-0">{brl(s.total)}</p>
              </li>
            ))}
          </ul>
          <dl className="px-4 py-3 space-y-1 text-sm border-t border-border bg-muted/30">
            {proposta.desconto > 0 && (
              <>
                <div className="flex justify-between"><dt className="text-muted-foreground">{T.subtotal}</dt><dd>{brl(proposta.subtotal)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">{T.desconto(proposta.desconto_percentual)}</dt><dd>- {brl(proposta.desconto)}</dd></div>
              </>
            )}
            <div className="flex justify-between text-base font-bold"><dt>{T.total}</dt><dd>{brl(proposta.total)}</dd></div>
          </dl>
        </section>

        {proposta.condicoes && (
          <section className="bg-card border border-border rounded-xl p-4">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">{T.condicoes}</h2>
            <p className="text-sm whitespace-pre-line">{proposta.condicoes}</p>
          </section>
        )}

        {proposta.observacoes && (
          <section className="bg-card border border-border rounded-xl p-4">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">{T.observacoes}</h2>
            <p className="text-sm whitespace-pre-line">{proposta.observacoes}</p>
          </section>
        )}

        {proposta.pode_aceitar && (
          <section className="bg-card border border-border rounded-xl p-4 space-y-3">
            <h2 className="font-semibold">{T.aceiteTitulo}</h2>
            <p className="text-xs text-muted-foreground">{T.aceiteTexto}</p>
            <label className="block text-xs font-medium" htmlFor="aceite-nome">{T.nomeRotulo}</label>
            <input
              id="aceite-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={T.nomePlaceholder}
              maxLength={120}
              autoComplete="name"
              className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2.5"
            />
            {erro && <p className="text-xs text-destructive">{erro}</p>}
            <button
              type="button"
              onClick={aceitar}
              disabled={enviando}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold py-3 disabled:opacity-60"
            >
              {enviando ? <><Loader2 size={16} className="animate-spin" /> {T.aceitando}</> : T.aceitar}
            </button>
          </section>
        )}

        <p className="text-center text-[11px] text-muted-foreground pt-2">{T.rodape(proposta.laboratorio.nome)}</p>
      </div>
    </div>
  );
}
