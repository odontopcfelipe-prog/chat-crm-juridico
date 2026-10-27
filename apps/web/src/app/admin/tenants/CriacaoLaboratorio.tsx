'use client';

/**
 * F3 do laboratório — chave da plataforma "Criação de laboratório" no /admin/tenants.
 * Desligada: o "Novo tenant" só cria clínica (a API responde 409 para laboratório).
 * Ligada: o "Novo tenant" oferece "Laboratório de prótese".
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Building2, FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

export interface EstadoCriacaoLaboratorio {
  liberada: boolean;
  atualizado_em: string | null;
}

/** Código do 409 quando a chave está desligada (POST /tenants com laboratório). */
export const CODIGO_CRIACAO_DESLIGADA = 'CRIACAO_LABORATORIO_DESLIGADA';

/** É laboratório só com o tipo exato; sem perfil (null) é clínica. */
export function ehLaboratorio(t?: { business_profile?: { business_type?: string | null } | null } | null): boolean {
  return t?.business_profile?.business_type === 'LABORATORIO';
}

const CONFIRMA_LIGAR =
  'Ligar a criação de laboratório?\n\n' +
  'Ligue só quando o suporte confirmar que as travas do laboratório já estão no servidor.\n\n' +
  'Com a chave ligada, o "Novo tenant" passa a oferecer "Laboratório de prótese". As clínicas não mudam.';

const CONFIRMA_DESLIGAR =
  'Desligar a criação de laboratório?\n\n' +
  'O "Novo tenant" volta a criar só clínica. Os laboratórios que já existem continuam como estão.';

export function useCriacaoLaboratorio() {
  const [estado, setEstado] = useState<EstadoCriacaoLaboratorio | null>(null);
  const [erro, setErro] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setErro(false);
    try {
      const { data } = await api.get<EstadoCriacaoLaboratorio>('/plataforma/criacao-laboratorio');
      setEstado({ liberada: data?.liberada === true, atualizado_em: data?.atualizado_em ?? null });
    } catch {
      setEstado(null);
      setErro(true);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  /** Liga/desliga com confirmação. Devolve se a criação ficou liberada. */
  const alternar = useCallback(async (liberar: boolean): Promise<boolean> => {
    if (!window.confirm(liberar ? CONFIRMA_LIGAR : CONFIRMA_DESLIGAR)) return false;
    setSalvando(true);
    try {
      const { data } = await api.put<EstadoCriacaoLaboratorio>('/plataforma/criacao-laboratorio', { liberada: liberar });
      const liberada = data?.liberada === true;
      setEstado({ liberada, atualizado_em: data?.atualizado_em ?? null });
      setErro(false);
      showSuccess(liberada ? 'Criação de laboratório ligada' : 'Criação de laboratório desligada');
      return liberada;
    } catch (err: any) {
      const msg = err?.response?.data?.message;
      showError(typeof msg === 'string' ? msg : 'Não foi possível mudar a criação de laboratório');
      return false;
    } finally {
      setSalvando(false);
    }
  }, []);

  return { estado, erro, salvando, carregar, alternar, liberada: estado?.liberada === true };
}

/** Bloco pequeno: "Criação de laboratório: desligada/ligada" + botão. */
export function BlocoCriacaoLaboratorio({
  estado, erro, salvando, onAlternar, onRecarregar,
}: {
  estado: EstadoCriacaoLaboratorio | null;
  erro: boolean;
  salvando: boolean;
  onAlternar: (liberar: boolean) => void;
  onRecarregar: () => void;
}) {
  const ligada = estado?.liberada === true;
  const carregando = !estado && !erro;
  const situacao = carregando ? 'carregando…' : erro ? 'não foi possível ler' : ligada ? 'ligada' : 'desligada';

  return (
    <div
      className={`mb-6 flex items-center gap-3 flex-wrap rounded-xl border px-4 py-2.5 ${
        ligada ? 'border-sky-500/30 bg-sky-500/5' : 'border-border bg-card'
      }`}
    >
      <FlaskConical size={16} className={`shrink-0 ${ligada ? 'text-sky-700 dark:text-sky-300' : 'text-muted-foreground'}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          Criação de laboratório:{' '}
          <strong className={ligada ? 'text-sky-700 dark:text-sky-300' : erro ? 'text-red-700 dark:text-red-300' : ''}>
            {situacao}
          </strong>
        </p>
        <p className="text-[11px] text-muted-foreground">
          {ligada
            ? 'O "Novo tenant" oferece "Laboratório de prótese".'
            : 'O "Novo tenant" cria só clínica.'}
          {estado?.atualizado_em && (
            <> · Alterada em {new Date(estado.atualizado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</>
          )}
        </p>
      </div>
      {erro ? (
        <button
          type="button"
          onClick={onRecarregar}
          className="text-xs font-bold px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/40 text-foreground inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} />
          Tentar de novo
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onAlternar(!ligada)}
          disabled={carregando || salvando}
          className={`text-xs font-bold px-3 py-1.5 rounded-md border inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
            ligada
              ? 'border-border bg-card hover:bg-accent/40 text-foreground'
              : 'border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300'
          }`}
        >
          {salvando && <Loader2 size={12} className="animate-spin" />}
          {ligada ? 'Desligar' : 'Ligar'}
        </button>
      )}
    </div>
  );
}

export type TipoDeConta = 'CLINICA' | 'LABORATORIO';

const OPCOES: { valor: TipoDeConta; Icon: typeof Building2; titulo: string; sub: string }[] = [
  { valor: 'CLINICA', Icon: Building2, titulo: 'Clínica', sub: 'Clínica odontológica, o cadastro de sempre' },
  { valor: 'LABORATORIO', Icon: FlaskConical, titulo: 'Laboratório de prótese', sub: 'Dentistas clientes e trabalhos' },
];

/** "Novo tenant": Clínica (padrão) ou Laboratório de prótese (só com a chave ligada). */
export function EscolhaDoTipoDeConta({
  tipo, onEscolher, estado, erro, salvando, onLigar, onRecarregar,
}: {
  tipo: TipoDeConta;
  onEscolher: (t: TipoDeConta) => void;
  estado: EstadoCriacaoLaboratorio | null;
  erro: boolean;
  salvando: boolean;
  onLigar: () => void;
  onRecarregar: () => void;
}) {
  const liberada = estado?.liberada === true;
  const carregando = !estado && !erro;
  const labEscolhido = tipo === 'LABORATORIO';

  return (
    <section>
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Tipo de conta</p>
      <div role="radiogroup" aria-label="Tipo de conta" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {OPCOES.map(({ valor, Icon, titulo, sub }) => {
          const ativo = tipo === valor;
          // Laboratório fica desabilitado com a chave desligada (se já estava escolhido, o envio é que trava)
          const desabilitado = valor === 'LABORATORIO' && !liberada && !ativo;
          const motivo = valor === 'LABORATORIO' && !liberada
            ? (carregando ? 'Conferindo a chave da plataforma…' : erro ? 'Chave da plataforma não lida' : 'Desligada na plataforma')
            : sub;
          return (
            <button
              key={valor}
              type="button"
              role="radio"
              aria-checked={ativo}
              disabled={desabilitado}
              onClick={() => onEscolher(valor)}
              title={desabilitado ? 'Criação de laboratório desligada na plataforma' : undefined}
              className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                ativo
                  ? 'border-violet-500 bg-violet-500/10 ring-2 ring-violet-500/25'
                  : desabilitado
                    ? 'border-border bg-muted/30 opacity-60 cursor-not-allowed'
                    : 'border-border bg-card hover:border-violet-300'
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon size={14} className={ativo ? 'text-violet-700 dark:text-violet-300' : 'text-muted-foreground'} />
                <span className="text-sm font-bold text-foreground">{titulo}</span>
              </span>
              <span className="block text-[11px] text-muted-foreground mt-1">{motivo}</span>
            </button>
          );
        })}
      </div>

      {!liberada && !carregando && (
        <p
          className={`mt-2 text-[11px] flex items-start gap-1.5 ${
            labEscolhido ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground'
          }`}
        >
          <AlertCircle size={11} className="shrink-0 mt-0.5" />
          <span>
            {erro
              ? 'Não foi possível ler a chave "Criação de laboratório". '
              : labEscolhido
                ? 'A criação de laboratório está desligada na plataforma: ligue para criar o laboratório, ou escolha Clínica. '
                : 'Laboratório: a "Criação de laboratório" está desligada na plataforma. '}
            <button
              type="button"
              onClick={erro ? onRecarregar : onLigar}
              disabled={salvando}
              className="font-bold underline underline-offset-2 hover:text-foreground disabled:opacity-50"
            >
              {erro ? 'Tentar de novo' : 'Ligar'}
            </button>
          </span>
        </p>
      )}

      {labEscolhido && liberada && (
        <p className="mt-2 text-[11px] text-sky-800 dark:text-sky-200 bg-sky-500/5 border border-sky-500/20 rounded-md px-3 py-2 flex items-start gap-1.5">
          <FlaskConical size={11} className="shrink-0 mt-0.5" />
          O laboratório nasce ativo, no plano Custom, sem período de teste e sem e-mail de boas-vindas. Ainda não passe o acesso ao
          laboratório: as telas com os nomes de laboratório chegam na próxima etapa (por enquanto ele veria as telas da clínica).
        </p>
      )}
    </section>
  );
}
