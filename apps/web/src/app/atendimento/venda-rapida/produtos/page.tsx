'use client';

/**
 * Aba Produtos da Venda Rápida, no jeito da lista de produtos do admin da Nuvemshop: foto,
 * estoque, preço e promocional editados na própria linha. O "produto" é o item da Tabela de
 * Preços (Procedure) marcado com o raio: tirar da venda aqui é o mesmo raio de lá.
 *
 * Estoque: "Infinito" é o item sem material ligado; com material, quantas vendas o saldo aguenta.
 * Escrita só para ADMIN, como na Tabela de Preços (o servidor confere de novo).
 */
import '../venda-skin.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Camera, Infinity as InfinityIcon, Loader2, Plus, Search, X, Zap, ZapOff } from 'lucide-react';
import { isLab } from '@crm/shared';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useBusinessType } from '@/lib/useBusinessType';
import { useRole } from '@/lib/useRole';
import MateriaisProcedimento, { BotaoMateriais } from '../../settings/procedures/MateriaisProcedimento';
import AbasVendaRapida from '../AbasVendaRapida';
import FotoProduto from '../FotoProduto';
import { fmtCentavos, paraCentavos } from '../pagamento-balcao';

type Estoque = { infinito: true } | { infinito: false; quantidade: number; limitado_por: string };

interface Produto {
  id: string;
  name: string;
  base_price: number;
  promo_price: number | null;
  photo_url: string | null;
  updated_at: string;
  quick_sale: boolean;
  qtd_materiais: number;
  estoque: Estoque;
}

const FOTO_MAX_BYTES = 2 * 1024 * 1024;

const erroDaApi = (e: unknown, padrao: string): string => {
  const msg = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof msg === 'string' ? msg : padrao;
};

/** Valor em R$ que salva ao sair do campo ou no Enter. Inválido volta ao que estava. */
function CampoPreco({
  rotulo,
  valor,
  onSalvar,
  podeFicarVazio,
  riscado,
  bloqueado,
}: {
  rotulo: string;
  valor: number | null;
  onSalvar: (novo: number | null) => Promise<void>;
  podeFicarVazio?: boolean;
  riscado?: boolean;
  bloqueado?: boolean;
}) {
  const formatar = (v: number | null) => (v === null ? '' : fmtCentavos(Math.round(v * 100)));
  const [texto, setTexto] = useState(formatar(valor));
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { setTexto(formatar(valor)); }, [valor]);

  const salvar = async () => {
    const limpo = texto.trim();
    if (limpo === '') {
      if (valor === null) return;
      if (!podeFicarVazio) {
        setTexto(formatar(valor));
        return;
      }
    }
    const centavos = limpo === '' ? null : paraCentavos(limpo);
    if (limpo !== '' && (centavos === null || centavos <= 0)) {
      showError('Valor inválido. Use o formato 150,00.');
      setTexto(formatar(valor));
      return;
    }
    const novo = centavos === null ? null : centavos / 100;
    if (novo === valor) {
      setTexto(formatar(valor));
      return;
    }
    setSalvando(true);
    try {
      await onSalvar(novo);
    } catch (e) {
      showError(erroDaApi(e, 'Não foi possível salvar o preço.'));
      setTexto(formatar(valor));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <label className={`flex w-28 items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5 focus-within:ring-2 focus-within:ring-primary/30 ${bloqueado ? 'opacity-70' : ''}`}>
      <span className="text-xs text-muted-foreground">R$</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={rotulo}
        value={texto}
        disabled={bloqueado || salvando}
        onChange={(e) => setTexto(e.target.value)}
        onBlur={() => void salvar()}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className={`w-full min-w-0 border-0 bg-transparent p-0 text-sm tabular-nums text-foreground outline-none ${riscado ? 'text-muted-foreground line-through' : ''}`}
      />
    </label>
  );
}

function LinhaProduto({
  item,
  podeEditar,
  mostrarMateriais,
  onMudou,
  onMateriais,
}: {
  item: Produto;
  podeEditar: boolean;
  mostrarMateriais: boolean;
  onMudou: (id: string, parte: Partial<Produto>) => void;
  onMateriais: () => void;
}) {
  const arquivoRef = useRef<HTMLInputElement>(null);
  const [enviandoFoto, setEnviandoFoto] = useState(false);
  const [mudandoVenda, setMudandoVenda] = useState(false);
  const emPromocao = item.promo_price !== null && item.promo_price < item.base_price;

  const salvarPreco = (campo: 'base_price' | 'promo_price') => async (novo: number | null) => {
    const { data } = await api.patch<{ base_price: unknown; promo_price: unknown; updated_at: string }>(`/procedures/${item.id}`, { [campo]: novo });
    onMudou(item.id, {
      base_price: Number(data.base_price),
      promo_price: data.promo_price === null || data.promo_price === undefined ? null : Number(data.promo_price),
      updated_at: data.updated_at,
    });
  };

  const enviarFoto = async (arquivo: File | undefined) => {
    if (!arquivo) return;
    if (arquivo.size > FOTO_MAX_BYTES) {
      showError('Imagem muito grande. O máximo é 2 MB.');
      return;
    }
    setEnviandoFoto(true);
    try {
      const fd = new FormData();
      fd.append('file', arquivo);
      const { data } = await api.post<{ photo_url: string; updated_at: string }>(`/procedures/${item.id}/photo`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      onMudou(item.id, { photo_url: data.photo_url, updated_at: data.updated_at });
    } catch (e) {
      showError(erroDaApi(e, 'Não foi possível enviar a foto.'));
    } finally {
      setEnviandoFoto(false);
      if (arquivoRef.current) arquivoRef.current.value = '';
    }
  };

  const removerFoto = async () => {
    if (!confirm(`Remover a foto de "${item.name}"?`)) return;
    try {
      await api.delete(`/procedures/${item.id}/photo`);
      onMudou(item.id, { photo_url: null });
    } catch (e) {
      showError(erroDaApi(e, 'Não foi possível remover a foto.'));
    }
  };

  const mudarVenda = async () => {
    setMudandoVenda(true);
    try {
      await api.patch(`/procedures/${item.id}`, { quick_sale: !item.quick_sale });
      onMudou(item.id, { quick_sale: !item.quick_sale });
      showSuccess(item.quick_sale ? 'Saiu da venda rápida' : 'Entrou na venda rápida');
    } catch (e) {
      showError(erroDaApi(e, 'Não foi possível mudar.'));
    } finally {
      setMudandoVenda(false);
    }
  };

  return (
    <tr className="align-middle hover:bg-muted/60">
      <td className="px-3 py-2.5">
        <div className="relative h-14 w-14 overflow-hidden rounded-md bg-muted">
          <FotoProduto id={item.id} temFoto={!!item.photo_url} versao={item.updated_at}>
            <span className="flex h-full w-full items-center justify-center text-muted-foreground/40">
              <Camera size={20} />
            </span>
          </FotoProduto>
          {enviandoFoto && (
            <span className="absolute inset-0 flex items-center justify-center bg-card/70">
              <Loader2 size={16} className="animate-spin text-primary" />
            </span>
          )}
          {podeEditar && (
            <>
              <button
                type="button"
                aria-label={item.photo_url ? `Trocar a foto de ${item.name}` : `Enviar foto de ${item.name}`}
                title={item.photo_url ? 'Trocar a foto' : 'Enviar foto'}
                disabled={enviandoFoto}
                onClick={() => arquivoRef.current?.click()}
                className="absolute inset-0"
              />
              {item.photo_url && (
                <button
                  type="button"
                  aria-label={`Remover a foto de ${item.name}`}
                  title="Remover a foto"
                  onClick={() => void removerFoto()}
                  className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                >
                  <X size={11} />
                </button>
              )}
              <input
                ref={arquivoRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                aria-label={`Arquivo da foto de ${item.name}`}
                className="hidden"
                onChange={(e) => void enviarFoto(e.target.files?.[0])}
              />
            </>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-sm font-medium text-foreground">
        {item.name}
        {emPromocao && (
          <span className="vr-verde ml-2 text-xs font-semibold">
            {Math.round((1 - (item.promo_price as number) / item.base_price) * 100)}% OFF
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-sm text-foreground">
        {item.estoque.infinito ? (
          <span className="inline-flex items-center gap-1"><InfinityIcon size={15} /> Infinito</span>
        ) : (
          <span title={`Quem limita é ${item.estoque.limitado_por}`} className={item.estoque.quantidade === 0 ? 'font-semibold text-red-600' : ''}>
            {item.estoque.quantidade} {item.estoque.quantidade === 1 ? 'venda' : 'vendas'}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <CampoPreco rotulo={`Preço de ${item.name}`} valor={item.base_price} onSalvar={salvarPreco('base_price')} riscado={emPromocao} bloqueado={!podeEditar} />
      </td>
      <td className="px-3 py-2.5">
        <CampoPreco rotulo={`Preço promocional de ${item.name}`} valor={item.promo_price} onSalvar={salvarPreco('promo_price')} podeFicarVazio bloqueado={!podeEditar} />
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right">
        {mostrarMateriais && <BotaoMateriais quantidade={item.qtd_materiais} onClick={onMateriais} />}
        {podeEditar && (
          <button
            type="button"
            disabled={mudandoVenda}
            onClick={() => void mudarVenda()}
            aria-label={item.quick_sale ? `Tirar ${item.name} da venda rápida` : `Colocar ${item.name} na venda rápida`}
            title={item.quick_sale ? 'Tirar da venda rápida' : 'Colocar na venda rápida'}
            className={`rounded p-1 transition-colors disabled:opacity-50 ${item.quick_sale ? 'text-amber-500 hover:text-amber-600' : 'text-muted-foreground/50 hover:text-foreground'}`}
          >
            {item.quick_sale ? <Zap size={16} /> : <ZapOff size={16} />}
          </button>
        )}
      </td>
    </tr>
  );
}

function NovoProduto({ onFechar, onCriado }: { onFechar: () => void; onCriado: () => void }) {
  const [nome, setNome] = useState('');
  const [preco, setPreco] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const criar = async (e: React.FormEvent) => {
    e.preventDefault();
    const centavos = paraCentavos(preco);
    if (!nome.trim()) return setErro('Digite o nome do produto.');
    if (centavos === null || centavos <= 0) return setErro('Digite o preço, no formato 150,00.');
    setSalvando(true);
    setErro(null);
    try {
      await api.post('/procedures', { name: nome.trim(), base_price: centavos / 100, quick_sale: true });
      showSuccess('Produto criado');
      onCriado();
    } catch (err) {
      setErro(erroDaApi(err, 'Não foi possível criar o produto.'));
      setSalvando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-label="Adicionar produto">
      <form onSubmit={(e) => void criar(e)} className="vr-card w-full max-w-sm p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Adicionar produto</h2>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="text-muted-foreground hover:text-foreground"><X size={18} /></button>
        </div>
        <label className="mb-3 block text-sm text-foreground">
          Nome
          <input
            autoFocus
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <label className="mb-1 block text-sm text-foreground">
          Preço
          <span className="mt-1 flex items-center gap-1 rounded-md border border-border bg-card px-3 py-2 focus-within:ring-2 focus-within:ring-primary/30">
            <span className="text-sm text-muted-foreground">R$</span>
            <input
              type="text"
              inputMode="decimal"
              value={preco}
              onChange={(e) => setPreco(e.target.value)}
              placeholder="0,00"
              className="w-full border-0 bg-transparent p-0 text-sm outline-none"
            />
          </span>
        </label>
        <p className="mb-3 text-xs text-muted-foreground">A foto e a promoção você coloca na lista, depois de criar.</p>
        {erro && <p role="alert" className="mb-3 text-xs font-semibold text-red-600">{erro}</p>}
        <button type="submit" disabled={salvando} className="vr-botao inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 text-sm">
          {salvando && <Loader2 size={14} className="animate-spin" />}
          Criar produto
        </button>
      </form>
    </div>
  );
}

export default function ProdutosPage() {
  const lab = isLab(useBusinessType());
  const { isAdmin } = useRole();
  // useRole lê o token, que não existe no servidor: só depois de montar, senão a hidratação quebra.
  const [montado, setMontado] = useState(false);
  useEffect(() => { setMontado(true); }, []);
  const podeEditar = montado && isAdmin;
  const [itens, setItens] = useState<Produto[] | null>(null);
  const [erro, setErro] = useState(false);
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<'dentro' | 'fora'>('dentro');
  const [criando, setCriando] = useState(false);
  const [materiaisDe, setMateriaisDe] = useState<Produto | null>(null);

  const carregar = useCallback(() => {
    setErro(false);
    api.get<Produto[]>('/procedures/catalogo')
      .then(({ data }) => setItens(data))
      .catch(() => setErro(true));
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const mudar = useCallback((id: string, parte: Partial<Produto>) => {
    setItens((atuais) => atuais && atuais.map((x) => (x.id === id ? { ...x, ...parte } : x)));
  }, []);

  const dentro = useMemo(() => (itens ?? []).filter((x) => x.quick_sale).length, [itens]);
  const fora = (itens?.length ?? 0) - dentro;
  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (itens ?? []).filter((x) => x.quick_sale === (filtro === 'dentro') && (!q || x.name.toLowerCase().includes(q)));
  }, [itens, busca, filtro]);

  return (
    <div className="vr-skin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6">
        <AbasVendaRapida className="mb-4 text-sm" />

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-foreground">Produtos</h1>
          {podeEditar && (
            <button type="button" onClick={() => setCriando(true)} className="vr-botao inline-flex items-center gap-1.5 px-3 py-2 text-sm">
              <Plus size={15} /> Adicionar produto
            </button>
          )}
        </div>

        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar produtos por nome"
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          {([['dentro', `Na venda rápida (${dentro})`], ['fora', `Fora da venda rápida (${fora})`]] as const).map(([chave, rotulo]) => (
            <button
              key={chave}
              type="button"
              aria-pressed={filtro === chave}
              onClick={() => setFiltro(chave)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                filtro === chave ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-foreground hover:bg-accent/40'
              }`}
            >
              {rotulo}
            </button>
          ))}
        </div>

        <div className="vr-card overflow-x-auto">
          {erro ? (
            <div role="alert" className="flex flex-col items-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground">
              <AlertCircle size={22} className="text-amber-600" />
              Não foi possível carregar os produtos.
              <button type="button" onClick={carregar} className="vr-link font-semibold">Tentar de novo</button>
            </div>
          ) : itens === null ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" /> Carregando produtos...
            </div>
          ) : visiveis.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground">
              {busca.trim() ? 'Nenhum produto com esse nome.' : filtro === 'dentro' ? 'Nenhum produto na venda rápida ainda.' : 'Todos os produtos já estão na venda rápida.'}
            </div>
          ) : (
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs font-semibold text-foreground">
                  <th className="px-3 py-2.5" colSpan={2}>Produto</th>
                  <th className="px-3 py-2.5">Estoque</th>
                  <th className="px-3 py-2.5">Preço</th>
                  <th className="px-3 py-2.5">Promocional</th>
                  <th aria-label="Ações" className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visiveis.map((item) => (
                  <LinhaProduto
                    key={item.id}
                    item={item}
                    podeEditar={podeEditar}
                    mostrarMateriais={!lab}
                    onMudou={mudar}
                    onMateriais={() => setMateriaisDe(item)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {criando && (
        <NovoProduto
          onFechar={() => setCriando(false)}
          onCriado={() => {
            setCriando(false);
            setFiltro('dentro');
            carregar();
          }}
        />
      )}

      {materiaisDe && (
        <MateriaisProcedimento
          procedureId={materiaisDe.id}
          procedureName={materiaisDe.name}
          onClose={() => {
            setMateriaisDe(null);
            carregar();
          }}
          onChanged={(total) => mudar(materiaisDe.id, { qtd_materiais: total })}
        />
      )}
    </div>
  );
}
