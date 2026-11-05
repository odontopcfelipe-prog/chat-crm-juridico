'use client';

/**
 * Passos CAD — o campo Cliente da ficha. O técnico escolhe na lista do cadastro ou digita outro nome.
 * Sem conexão ou sem permissão, a lista fica vazia e digitar continua funcionando.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { buscarClientesDoCadastro } from './clientes-do-cadastro';
import { nomesDoCadastro, opcoesDeCliente } from './ficha';
import { TEXTOS as T } from './textos';

type Estado = 'buscando' | 'pronto' | 'falhou';

/** Lista enorme na tela deixa cada tecla lenta; quem tem mais que isso filtra digitando. */
const MAIS_NOMES_NA_TELA = 200;

function useClientesDoCadastro() {
  const [nomes, setNomes] = useState<string[]>([]);
  const [estado, setEstado] = useState<Estado>('buscando');
  const pedido = useRef<AbortController | null>(null);

  const buscar = useCallback(() => {
    pedido.current?.abort();
    const atual = new AbortController();
    pedido.current = atual;
    buscarClientesDoCadastro(atual.signal)
      .then((resposta) => {
        if (atual.signal.aborted) return;
        setNomes(nomesDoCadastro(resposta));
        setEstado('pronto');
      })
      .catch(() => {
        if (!atual.signal.aborted) setEstado('falhou');
      });
  }, []);

  useEffect(() => {
    buscar();
    return () => pedido.current?.abort();
  }, [buscar]);

  const tentarDeNovo = () => {
    setEstado('buscando');
    buscar();
  };
  return { nomes, estado, tentarDeNovo };
}

export function CampoCliente({ id, valor, recentes, className, aoMudar }: { id: string; valor: string; recentes: readonly string[]; className: string; aoMudar: (v: string) => void }) {
  const { nomes, estado, tentarDeNovo } = useClientesDoCadastro();
  const [aberto, setAberto] = useState(false);
  // Vazio mostra tudo: quem já escolheu um nome e abre a lista quer ver os outros, não só ele.
  const [busca, setBusca] = useState('');
  // Guarda o nome, não a posição: a lista pode chegar com ela aberta e mudar quem está em cada linha.
  const [ativo, setAtivo] = useState<string | null>(null);
  const idDaLista = useId();
  const idDaOpcao = (i: number) => `${idDaLista}-${i}`;

  const opcoes = useMemo(() => opcoesDeCliente(nomes, recentes, busca), [nomes, recentes, busca]);
  const doCadastro = opcoes.cadastro.slice(0, MAIS_NOMES_NA_TELA);
  const outros = opcoes.outros.slice(0, MAIS_NOMES_NA_TELA - doCadastro.length);
  const visiveis = [...doCadastro, ...outros];
  const cortou = visiveis.length < opcoes.cadastro.length + opcoes.outros.length;
  const indiceAtivo = ativo === null ? -1 : visiveis.indexOf(ativo);

  useEffect(() => {
    if (aberto && indiceAtivo >= 0) document.getElementById(`${idDaLista}-${indiceAtivo}`)?.scrollIntoView({ block: 'nearest' });
  }, [aberto, indiceAtivo, idDaLista]);

  const abrir = () => {
    if (estado === 'falhou') tentarDeNovo();
    setBusca('');
    setAtivo(valor);
    setAberto(true);
  };
  const escolher = (nome: string) => {
    aoMudar(nome);
    setAberto(false);
  };
  const noTeclado = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!aberto) {
        abrir();
        return;
      }
      if (visiveis.length === 0) return;
      const passo = e.key === 'ArrowDown' ? 1 : -1;
      const proximo = indiceAtivo < 0 && passo < 0 ? visiveis.length - 1 : (indiceAtivo + passo + visiveis.length) % visiveis.length;
      setAtivo(visiveis[proximo]);
    } else if (e.key === 'Enter' && aberto) {
      // Sem nada marcado pelo teclado, vale o que foi digitado.
      e.preventDefault();
      if (indiceAtivo >= 0) escolher(visiveis[indiceAtivo]);
      else setAberto(false);
    } else if (e.key === 'Escape' && aberto) {
      setAberto(false);
    }
  };

  const aviso =
    estado === 'buscando' && nomes.length === 0
      ? T.clienteBuscando
      : estado === 'falhou'
        ? T.clienteFalhou
        : visiveis.length === 0
          ? busca
            ? T.clienteSemAchado
            : T.clienteVazio
          : null;

  const opcao = (nome: string, i: number) => (
    <li
      key={nome}
      id={idDaOpcao(i)}
      role="option"
      aria-selected={nome === valor}
      data-testid="cliente-opcao"
      // O mouse só pinta (hover): se marcasse o nome, um Enter com ele parado em cima gravaria o nome
      // que está embaixo dele no lugar do que foi digitado.
      className={`px-2.5 py-1.5 text-sm text-foreground truncate cursor-pointer hover:bg-muted ${i === indiceAtivo ? 'bg-muted' : ''} ${nome === valor ? 'font-semibold' : ''}`}
      onClick={() => escolher(nome)}
    >
      {nome}
    </li>
  );
  const grupo = (texto: string) => (
    <li role="presentation" className="px-2.5 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">
      {texto}
    </li>
  );

  return (
    <div className="relative min-w-0">
      <input
        id={id}
        data-testid="caso-cliente"
        role="combobox"
        aria-expanded={aberto}
        aria-controls={idDaLista}
        aria-autocomplete="list"
        aria-activedescendant={aberto && indiceAtivo >= 0 ? idDaOpcao(indiceAtivo) : undefined}
        autoComplete="off"
        className={`${className} pr-8`}
        value={valor}
        placeholder={T.fichaClienteEx}
        onChange={(e) => {
          aoMudar(e.target.value);
          setBusca(e.target.value);
          setAtivo(null);
          setAberto(true);
        }}
        onClick={() => {
          if (!aberto) abrir();
        }}
        onKeyDown={noTeclado}
        onBlur={() => setAberto(false)}
      />
      {/* Não rouba o foco do campo: é ele que fecha a lista ao sair. */}
      <button
        type="button"
        tabIndex={-1}
        data-testid="cliente-abrir"
        aria-label={T.clienteAbrirLista}
        title={T.clienteAbrirLista}
        className="absolute inset-y-0 right-0 w-8 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (aberto) {
            setAberto(false);
            return;
          }
          document.getElementById(id)?.focus();
          abrir();
        }}
      >
        <ChevronDown size={16} className={aberto ? 'rotate-180' : ''} />
      </button>
      {aberto && (
        <ul
          id={idDaLista}
          role="listbox"
          aria-label={T.fichaCliente}
          data-testid="clientes-lista"
          className="absolute z-30 left-0 right-0 top-full mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-card shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          {aviso && (
            <li role="presentation" data-testid="cliente-aviso" className="px-2.5 py-2 text-xs text-muted-foreground">
              {aviso}
            </li>
          )}
          {doCadastro.length > 0 && grupo(T.clienteDoCadastro)}
          {doCadastro.map((n, i) => opcao(n, i))}
          {outros.length > 0 && grupo(T.clienteOutros)}
          {outros.map((n, i) => opcao(n, doCadastro.length + i))}
          {cortou && (
            <li role="presentation" className="px-2.5 py-2 text-xs text-muted-foreground">
              {T.clienteMais}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
