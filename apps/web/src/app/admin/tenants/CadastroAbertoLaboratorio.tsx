'use client';

/**
 * F11 do laboratório — chave da plataforma "Cadastro aberto ao público" (LAB_SIGNUP_ENABLED)
 * no /admin/tenants, logo abaixo da "Criação de laboratório" da F3.
 *
 * Desligada (padrão): sem convite, o /cadastrar do laboratório mostra a lista de espera.
 * Ligada: qualquer pessoa cria a conta do laboratório pelo /cadastrar, sem convite.
 * Ela só tem efeito com a "Criação de laboratório" também ligada (o servidor exige as duas),
 * por isso o "Ligar" fica travado enquanto a da F3 estiver desligada.
 *
 * Todo texto visível vem de ../lab-cadastro-admin-textos (LAB_CADASTRO_ABERTO_ADMIN).
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Globe, Loader2, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { LAB_CADASTRO_ABERTO_ADMIN } from '../lab-cadastro-admin-textos';

const T = LAB_CADASTRO_ABERTO_ADMIN;
const ROTA_CHAVE = '/plataforma/cadastro-laboratorio';

export interface EstadoCadastroAberto {
  aberto: boolean;
  criacao_liberada: boolean;
  atualizado_em: string | null;
}

function lerEstado(data: Partial<EstadoCadastroAberto> | null | undefined): EstadoCadastroAberto {
  return {
    aberto: data?.aberto === true,
    criacao_liberada: data?.criacao_liberada === true,
    atualizado_em: typeof data?.atualizado_em === 'string' ? data.atualizado_em : null,
  };
}

/** Mensagem do servidor (string ou string[]) só nos 400/409; senão o padrão. */
function msgDoServidor(err: unknown, padrao: string): string {
  const r = (err as { response?: { status?: number; data?: { message?: unknown } } })?.response;
  if (r?.status !== 400 && r?.status !== 409) return padrao;
  const m = r?.data?.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (Array.isArray(m)) {
    const partes = m.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (partes.length) return partes.join(', ');
  }
  return padrao;
}

export function useCadastroAbertoLaboratorio() {
  const [estado, setEstado] = useState<EstadoCadastroAberto | null>(null);
  const [erro, setErro] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setErro(false);
    try {
      const { data } = await api.get<EstadoCadastroAberto>(ROTA_CHAVE);
      setEstado(lerEstado(data));
    } catch {
      setEstado(null);
      setErro(true);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  /** Liga/desliga com confirmação. Devolve se o cadastro aberto ficou ligado. */
  const alternar = useCallback(async (aberto: boolean): Promise<boolean> => {
    if (!window.confirm(aberto ? T.confirmaLigar : T.confirmaDesligar)) return false;
    setSalvando(true);
    try {
      const { data } = await api.put<EstadoCadastroAberto>(ROTA_CHAVE, { aberto });
      const novo = lerEstado(data);
      setEstado(novo);
      setErro(false);
      showSuccess(novo.aberto ? T.toastLigado : T.toastDesligado);
      return novo.aberto;
    } catch (err) {
      showError(msgDoServidor(err, T.toastErro));
      return false;
    } finally {
      setSalvando(false);
    }
  }, []);

  return { estado, erro, salvando, carregar, alternar, aberto: estado?.aberto === true };
}

/** Bloco pequeno, colado embaixo do da "Criação de laboratório". */
export function BlocoCadastroAbertoLaboratorio({
  estado, erro, salvando, criacaoLiberada, onAlternar, onRecarregar,
}: {
  estado: EstadoCadastroAberto | null;
  erro: boolean;
  salvando: boolean;
  criacaoLiberada: boolean;
  onAlternar: (aberto: boolean) => void;
  onRecarregar: () => void;
}) {
  const ligado = estado?.aberto === true;
  const carregando = !estado && !erro;
  const situacao = carregando ? T.carregando : erro ? T.naoLeu : ligado ? T.ligado : T.desligado;
  // Ligar só com a "Criação de laboratório" ligada; desligar sempre pode.
  const travado = !ligado && criacaoLiberada !== true;
  const semEfeito = ligado && criacaoLiberada !== true;

  return (
    <div
      className={`-mt-4 mb-6 rounded-xl border px-4 py-2.5 ${
        ligado ? 'border-sky-500/30 bg-sky-500/5' : 'border-border bg-card'
      }`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <Globe size={16} className={`shrink-0 ${ligado ? 'text-sky-700 dark:text-sky-300' : 'text-muted-foreground'}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            {T.rotulo}:{' '}
            <strong className={ligado ? 'text-sky-700 dark:text-sky-300' : erro ? 'text-red-700 dark:text-red-300' : ''}>
              {situacao}
            </strong>
          </p>
          {estado && (
            <p className="text-[11px] text-muted-foreground">
              {ligado ? T.descLigado : T.descDesligado}
              {T.separador}
              {T.vale}
              {estado.atualizado_em && (
                <>
                  {T.separador}
                  {T.alterado(new Date(estado.atualizado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}
                </>
              )}
            </p>
          )}
          {travado && !carregando && !erro && (
            <p className="text-[11px] text-muted-foreground mt-0.5">{T.ligarTravado}</p>
          )}
        </div>
        {erro ? (
          <button
            type="button"
            onClick={onRecarregar}
            className="text-xs font-bold px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/40 text-foreground inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} />
            {T.tentar}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onAlternar(!ligado)}
            disabled={carregando || salvando || travado}
            title={travado && !carregando ? T.ligarTravado : undefined}
            className={`text-xs font-bold px-3 py-1.5 rounded-md border inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
              ligado
                ? 'border-border bg-card hover:bg-accent/40 text-foreground'
                : 'border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300'
            }`}
          >
            {salvando && <Loader2 size={12} className="animate-spin" />}
            {ligado ? T.desligar : T.ligar}
          </button>
        )}
      </div>

      {semEfeito && (
        <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-200 bg-amber-500/5 border border-amber-500/20 rounded-md px-3 py-2 flex items-start gap-1.5">
          <AlertCircle size={11} className="shrink-0 mt-0.5" />
          <span>{T.semEfeito}</span>
        </p>
      )}
      {!ligado && !carregando && !erro && (
        <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-200 bg-amber-500/5 border border-amber-500/20 rounded-md px-3 py-2 flex items-start gap-1.5">
          <AlertCircle size={11} className="shrink-0 mt-0.5" />
          <span>{T.avisoPrecos}</span>
        </p>
      )}
    </div>
  );
}
