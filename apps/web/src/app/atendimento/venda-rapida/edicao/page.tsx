'use client';

/**
 * Edição básica da Venda Rápida, no jeito do editor de loja da Nuvemshop: a cor de cada parte
 * da tela e o tamanho das fotos, com a prévia ao lado. Vale para a Nova venda desta conta.
 * Escrita só para ADMIN, como a aba Produtos (o servidor confere de novo).
 */
import '../venda-skin.css';
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import {
  APARENCIA_PADRAO,
  PARTES,
  TAMANHOS,
  normalizarAparencia,
  textoSobre,
  type Aparencia,
  type TamanhoFoto,
} from '../aparencia';
import { guardarAparenciaLocal } from '../useAparenciaVenda';

const iguais = (a: Aparencia, b: Aparencia) => JSON.stringify(a) === JSON.stringify(b);

/** Quantos cartões cabem por linha na prévia, e a altura da foto, em cada tamanho. */
const PREVIA: Record<TamanhoFoto, { colunas: string; foto: string; qtd: number }> = {
  pequeno: { colunas: 'grid-cols-5', foto: 'h-5', qtd: 5 },
  medio: { colunas: 'grid-cols-4', foto: 'h-8', qtd: 4 },
  grande: { colunas: 'grid-cols-3', foto: 'h-14', qtd: 3 },
};

function CartoesDaPrevia({ tamanho }: { tamanho: TamanhoFoto }) {
  const { colunas, foto, qtd } = PREVIA[tamanho];
  return (
    <div className={`grid gap-1.5 ${colunas}`}>
      {Array.from({ length: qtd }, (_, i) => (
        <div key={i} className="rounded-sm bg-white p-1 shadow-sm">
          <div className={`rounded-sm bg-black/10 ${foto}`} />
          <div className="mt-1 h-1 w-3/4 rounded-full bg-black/20" />
          <div className="mt-0.5 h-1 w-1/2 rounded-full bg-black/40" />
        </div>
      ))}
    </div>
  );
}

function Previa({ aparencia }: { aparencia: Aparencia }) {
  const { cor_cabecalho, cor_produtos, cor_destaque, cor_rodape, tamanho_foto } = aparencia;
  return (
    <div aria-label="Prévia da tela de venda" role="img" className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 px-3 py-2.5" style={{ backgroundColor: cor_cabecalho, color: textoSobre(cor_cabecalho) }}>
        <span className="shrink-0 text-[11px] font-bold">Venda rápida</span>
        <span className="h-4 max-w-[220px] flex-1 rounded-sm bg-white shadow-sm" />
      </div>
      <div className="relative">
        <div className="py-3 pl-3 pr-[calc(30%+0.75rem)]" style={{ backgroundColor: cor_produtos }}>
          <div className="rounded-sm bg-white p-2 shadow-sm">
            <p className="mb-1.5 text-[10px] font-semibold text-black/80">Produtos</p>
            <CartoesDaPrevia tamanho={tamanho_foto} />
          </div>
        </div>
        <div className="py-3 pl-3 pr-[calc(30%+0.75rem)]" style={{ backgroundColor: cor_destaque }}>
          <p className="mb-1.5 text-[10px] font-semibold" style={{ color: textoSobre(cor_destaque) }}>Produtos em destaque</p>
          <CartoesDaPrevia tamanho={tamanho_foto} />
        </div>
        <div className="absolute right-3 top-3 w-[30%] rounded-sm bg-white p-2 shadow-md">
          <p className="text-[10px] font-semibold text-black/80">Carrinho</p>
          <div className="mt-1.5 h-10 rounded-sm bg-black/5" />
          <div className="mt-1.5 h-3 rounded-sm bg-[#3483fa]" />
        </div>
      </div>
      <div className="px-3 py-2 text-[10px] font-semibold" style={{ backgroundColor: cor_rodape, color: textoSobre(cor_rodape) }}>
        Rodapé
      </div>
    </div>
  );
}

export default function EdicaoBasicaPage() {
  const { isAdmin } = useRole();
  // useRole lê o token, que não existe no servidor: só depois de montar, senão a hidratação quebra.
  const [montado, setMontado] = useState(false);
  useEffect(() => { setMontado(true); }, []);
  const podeEditar = montado && isAdmin;

  const [salva, setSalva] = useState<Aparencia | null>(null);
  const [rascunho, setRascunho] = useState<Aparencia>(APARENCIA_PADRAO);
  const [erro, setErro] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(() => {
    setErro(false);
    api.get('/procedures/aparencia-venda')
      .then(({ data }) => {
        const atual = normalizarAparencia(data);
        setSalva(atual);
        setRascunho(atual);
      })
      .catch(() => setErro(true));
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const salvar = async () => {
    setSalvando(true);
    try {
      const { data } = await api.put('/procedures/aparencia-venda', rascunho);
      const atual = normalizarAparencia(data);
      setSalva(atual);
      setRascunho(atual);
      guardarAparenciaLocal(atual);
      showSuccess('Salvo. A Nova venda já abre assim.');
    } catch {
      showError('Não foi possível salvar. Tente de novo.');
    } finally {
      setSalvando(false);
    }
  };

  const mudou = salva !== null && !iguais(salva, rascunho);

  return (
    <div className="vr-skin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6 pb-24 md:pb-6">
        <h1 className="text-2xl font-bold text-foreground">Edição básica</h1>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">Muda a tela de Nova venda desta conta.</p>

        {erro ? (
          <div role="alert" className="vr-card flex flex-col items-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground">
            <AlertCircle size={22} className="text-amber-600" />
            Não foi possível carregar a edição.
            <button type="button" onClick={carregar} className="vr-link font-semibold">Tentar de novo</button>
          </div>
        ) : salva === null ? (
          <div className="vr-card flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" /> Carregando...
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
            <div className="space-y-4">
              <fieldset disabled={!podeEditar || salvando} className="vr-card p-4">
                <legend className="float-left mb-2 w-full text-sm font-bold text-foreground">Cor de fundo</legend>
                <div className="clear-both divide-y divide-border">
                  {PARTES.map((parte) => (
                    <label key={parte.campo} className="flex items-center gap-3 py-2.5">
                      <input
                        type="color"
                        value={rascunho[parte.campo]}
                        onChange={(e) => setRascunho((atual) => ({ ...atual, [parte.campo]: e.target.value.toLowerCase() }))}
                        className="h-9 w-11 shrink-0 cursor-pointer rounded border border-border bg-card p-0.5 disabled:cursor-not-allowed"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-foreground">{parte.rotulo}</span>
                        <span className="block text-xs text-muted-foreground">{parte.dica}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset disabled={!podeEditar || salvando} className="vr-card p-4">
                <legend className="float-left mb-3 w-full text-sm font-bold text-foreground">Tamanho das fotos</legend>
                <div className="clear-both grid grid-cols-3 gap-2">
                  {(Object.keys(TAMANHOS) as TamanhoFoto[]).map((tamanho) => (
                    <button
                      key={tamanho}
                      type="button"
                      aria-pressed={rascunho.tamanho_foto === tamanho}
                      onClick={() => setRascunho((atual) => ({ ...atual, tamanho_foto: tamanho }))}
                      className={`rounded-md border px-2 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${
                        rascunho.tamanho_foto === tamanho ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-foreground hover:bg-accent/40'
                      }`}
                    >
                      {TAMANHOS[tamanho].rotulo}
                    </button>
                  ))}
                </div>
              </fieldset>

              {podeEditar ? (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={!mudou || salvando}
                    onClick={() => void salvar()}
                    className="vr-botao inline-flex items-center gap-2 px-5 py-2.5 text-sm"
                  >
                    {salvando && <Loader2 size={14} className="animate-spin" />}
                    Salvar
                  </button>
                  <button
                    type="button"
                    disabled={salvando || iguais(rascunho, APARENCIA_PADRAO)}
                    onClick={() => setRascunho(APARENCIA_PADRAO)}
                    className="vr-link text-sm font-semibold disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40"
                  >
                    Voltar ao padrão
                  </button>
                </div>
              ) : montado && (
                <p className="text-xs text-muted-foreground">Só o administrador muda a aparência.</p>
              )}
            </div>

            <div className="vr-card p-4 lg:sticky lg:top-4">
              <p className="mb-3 text-sm font-bold text-foreground">Como fica</p>
              <Previa aparencia={rascunho} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
