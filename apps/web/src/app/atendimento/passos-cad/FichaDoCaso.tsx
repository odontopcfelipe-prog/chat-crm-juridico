'use client';

/**
 * Passos CAD — a primeira etapa: a ficha do caso, em três colunas. À esquerda o projeto, no meio a
 * definição do trabalho com a arcada clicável, à direita as ações.
 */
import { useState, type ReactNode } from 'react';
import { Check, FilePlus2, Layers, Loader2, PenTool, Upload, type LucideIcon } from 'lucide-react';
import { CampoCliente } from './CampoCliente';
import { CampoDeBroca, Campo } from './campos';
import type { FichaCaso, Recentes } from './ficha';
import { Odontograma } from './Odontograma';
import { CORES_DO_DENTE, MATERIAIS, TEXTOS as T } from './textos';

interface Props {
  ficha: FichaCaso;
  aoMudarFicha: (f: FichaCaso) => void;
  recentes: Recentes;
  fdi: number | null;
  /** Já existe coroa desenhada: trocar o dente ou o material apaga o trabalho. */
  temCoroa: boolean;
  aoEscolherDente: (fdi: number) => void;
  materialId: string;
  aoMudarMaterial: (id: string) => void;
  diametroBroca: number;
  aoMudarBroca: (v: number) => void;
  nomeArco: string | null;
  nomeAnt: string | null;
  aoAbrirArquivo: (qual: 'arco' | 'antagonista', f: File) => void;
  aoDesenhar: () => void;
  aoComecarNovo: () => void;
  ocupado: string | null;
  erro: string | null;
}

const estiloCampo = 'w-full min-w-0 px-2.5 py-1.5 rounded-md border border-border bg-background text-sm';

const Linha = ({ rotulo, children }: { rotulo: string; children: ReactNode }) => (
  <label className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
    <span className="text-sm text-muted-foreground">{rotulo}</span>
    {children}
  </label>
);

const Titulo = ({ children }: { children: ReactNode }) => <h2 className="text-2xl font-light text-foreground">{children}</h2>;

/** Quadradinho de cor com o ícone, à esquerda de cada ação. */
const Selo = ({ Icone, cor }: { Icone: LucideIcon; cor: string }) => (
  <span className={`w-9 h-9 shrink-0 rounded-md inline-flex items-center justify-center ${cor}`}>
    <Icone size={18} />
  </span>
);

const AcaoDeArquivo = ({ testid, titulo, ajuda, nome, Icone, cor, travado, aoEscolher }: { testid: string; titulo: string; ajuda: string; nome: string | null; Icone: LucideIcon; cor: string; travado: boolean; aoEscolher: (f: File) => void }) => (
  <label className={`relative flex items-center gap-3 p-1.5 rounded-lg focus-within:outline focus-within:outline-2 focus-within:outline-primary ${travado ? 'opacity-50' : 'hover:bg-muted cursor-pointer'}`}>
    <Selo Icone={Icone} cor={cor} />
    <span className="min-w-0">
      <span className="block text-sm text-foreground">{titulo}</span>
      <span className={`flex items-center gap-1 text-[11px] ${nome ? 'text-primary' : 'text-muted-foreground'}`}>
        {nome && <Check size={12} className="shrink-0" />}
        <span className="truncate">{nome ?? ajuda}</span>
      </span>
    </span>
    <input
      type="file"
      data-testid={testid}
      accept=".stl,.obj,.ply"
      disabled={travado}
      className="sr-only"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) aoEscolher(f);
        e.target.value = '';
      }}
    />
  </label>
);

export function FichaDoCaso(p: Props) {
  const { ficha } = p;
  const [confirmandoNovo, setConfirmandoNovo] = useState(false);
  const [trocaPendente, setTrocaPendente] = useState<(() => void) | null>(null);
  const proteger = (troca: () => void) => {
    if (p.temCoroa) setTrocaPendente(() => troca);
    else troca();
  };
  const muda = (campo: keyof FichaCaso) => (e: { target: { value: string } }) => p.aoMudarFicha({ ...ficha, [campo]: e.target.value });
  const travado = Boolean(p.ocupado);
  const temAlgoAberto = Boolean(p.nomeArco || p.nomeAnt || p.fdi || ficha.numero || ficha.cliente || ficha.nomeDoCaso || ficha.notas);
  const falta = !p.nomeArco ? T.faltaArco : !p.fdi ? T.faltaDente : null;

  return (
    <div className="absolute inset-0 z-20 overflow-y-auto bg-background" data-testid="ficha-do-caso">
      <div className="min-h-full lg:h-full lg:min-h-[620px] grid grid-cols-1 lg:grid-cols-[minmax(290px,1.2fr)_minmax(320px,1fr)_minmax(190px,0.5fr)]">
        {/* Projeto */}
        <section className="flex flex-col gap-3 p-5 min-h-0 bg-card border-b lg:border-b-0 lg:border-r border-border" data-testid="ficha-projeto">
          <div>
            <h1 className="text-xs font-semibold text-muted-foreground">{`${T.titulo} · ${T.subtitulo}`}</h1>
            <div className="flex items-center justify-between gap-3 mt-1">
              <Titulo>{T.fichaProjeto}</Titulo>
              <button type="button" data-testid="caso-novo" disabled={travado} onClick={() => (temAlgoAberto ? setConfirmandoNovo(true) : p.aoComecarNovo())} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-40">
                <FilePlus2 size={14} /> {T.fichaNovo}
              </button>
            </div>
          </div>
          {confirmandoNovo && (
            <div className="p-2.5 rounded-md border border-amber-500/50 bg-amber-500/10 text-xs" data-testid="confirmar-novo">
              <p className="text-foreground">{T.fichaNovoPergunta}</p>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  data-testid="confirmar-novo-sim"
                  disabled={travado}
                  className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground font-semibold disabled:opacity-40"
                  onClick={() => {
                    setConfirmandoNovo(false);
                    p.aoComecarNovo();
                  }}
                >
                  {T.fichaApagar}
                </button>
                <button type="button" className="px-2.5 py-1 rounded-md border border-border" onClick={() => setConfirmandoNovo(false)}>
                  {T.fichaCancelar}
                </button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
            <span className="text-sm text-muted-foreground">{T.fichaData}</span>
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="text-sm text-foreground whitespace-nowrap" data-testid="caso-data">{ficha.abertoEm}</span>
              <label className="flex items-center gap-2 min-w-0">
                <span className="text-sm text-muted-foreground whitespace-nowrap">{T.fichaNumero}</span>
                <input data-testid="caso-numero" className={`${estiloCampo} max-w-[7rem]`} value={ficha.numero} onChange={muda('numero')} placeholder={T.nomeCasoExemplo} />
              </label>
            </div>
          </div>
          {/* Fora do <label>: clicar numa opção da lista não pode voltar a clicar no campo. */}
          <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
            <label htmlFor="passos-cad-cliente" className="text-sm text-muted-foreground">{T.fichaCliente}</label>
            <CampoCliente id="passos-cad-cliente" className={estiloCampo} valor={ficha.cliente} recentes={p.recentes.clientes} aoMudar={(cliente) => p.aoMudarFicha({ ...ficha, cliente })} />
          </div>
          <Linha rotulo={T.fichaPaciente}>
            <input data-testid="caso-nome" className={estiloCampo} value={ficha.nomeDoCaso} onChange={muda('nomeDoCaso')} autoComplete="off" />
          </Linha>
          <Linha rotulo={T.fichaTecnico}>
            <input data-testid="caso-tecnico" list="passos-cad-tecnicos" className={estiloCampo} value={ficha.tecnico} onChange={muda('tecnico')} />
          </Linha>
          <datalist id="passos-cad-tecnicos">
            {p.recentes.tecnicos.map((n) => <option key={n} value={n} />)}
          </datalist>
          <textarea data-testid="caso-notas" aria-label={T.fichaNotas} className={`${estiloCampo} flex-1 min-h-[6rem] resize-none`} value={ficha.notas} onChange={muda('notas')} placeholder={T.fichaNotasEx} />
          <div>
            <p className="text-sm text-muted-foreground mb-1.5">{T.fichaOpcoes}</p>
            <Campo rotulo={T.pBroca} ajuda={T.brocaAjuda}>
              <CampoDeBroca testid="diametro-broca" className={`${estiloCampo} max-w-[7rem]`} travado={travado} valor={p.diametroBroca} aoMudar={p.aoMudarBroca} />
            </Campo>
          </div>
        </section>

        {/* Definição do trabalho */}
        <section className="flex flex-col gap-3 p-5 min-h-0 bg-background" data-testid="ficha-trabalho">
          <Titulo>{T.fichaTrabalho}</Titulo>
          {trocaPendente && (
            <div className="p-2.5 rounded-md border border-amber-500/50 bg-amber-500/10 text-xs" data-testid="confirmar-troca">
              <p className="text-foreground">{T.fichaTrocaPergunta}</p>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  data-testid="confirmar-troca-sim"
                  className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground font-semibold"
                  onClick={() => {
                    trocaPendente();
                    setTrocaPendente(null);
                  }}
                >
                  {T.fichaTrocaSim}
                </button>
                <button type="button" className="px-2.5 py-1 rounded-md border border-border" onClick={() => setTrocaPendente(null)}>
                  {T.fichaCancelar}
                </button>
              </div>
            </div>
          )}
          <div className="flex-1 min-h-[440px] lg:min-h-[320px] flex items-center justify-center [container-type:size]">
            <Odontograma
              selecionado={p.fdi}
              travado={travado}
              aoEscolher={(n) => {
                if (n !== p.fdi) proteger(() => p.aoEscolherDente(n));
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Campo rotulo={T.fichaCor}>
              <select data-testid="caso-cor" className={estiloCampo} value={ficha.cor} onChange={muda('cor')}>
                {CORES_DO_DENTE.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Campo>
            <Campo rotulo={T.material}>
              <select data-testid="caso-material" className={estiloCampo} value={p.materialId} disabled={travado} onChange={(e) => {
                const id = e.target.value;
                proteger(() => p.aoMudarMaterial(id));
              }}>
                {MATERIAIS.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
              </select>
            </Campo>
          </div>
        </section>

        {/* Ações */}
        <section className="flex flex-col gap-2 p-5 pb-28 md:pb-5 min-h-0 bg-card border-t lg:border-t-0 lg:border-l border-border" data-testid="ficha-acoes">
          <Titulo>{T.fichaAcoes}</Titulo>
          <div className="mt-2 space-y-1">
            <AcaoDeArquivo testid="arquivo-arco" titulo={T.acaoArco} ajuda={T.acaoArcoAjuda} nome={p.nomeArco} Icone={Upload} cor="bg-amber-500/15 text-amber-700" travado={travado} aoEscolher={(f) => p.aoAbrirArquivo('arco', f)} />
            <AcaoDeArquivo testid="arquivo-antagonista" titulo={T.acaoAnt} ajuda={T.acaoAntAjuda} nome={p.nomeAnt} Icone={Layers} cor="bg-sky-500/15 text-sky-700" travado={travado} aoEscolher={(f) => p.aoAbrirArquivo('antagonista', f)} />
          </div>
          <p className="text-[11px] text-muted-foreground px-1.5">{T.antagonistaAjuda}</p>
          <button type="button" data-testid="avancar" disabled={Boolean(falta) || travado} onClick={p.aoDesenhar} className="mt-3 w-full flex items-center gap-3 p-1.5 rounded-lg text-left hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent">
            <Selo Icone={PenTool} cor="bg-primary text-primary-foreground" />
            <span className="text-sm font-semibold text-foreground">{T.acaoDesenhar}</span>
          </button>
          {falta && <p className="text-[11px] text-muted-foreground px-1.5" data-testid="falta">{falta}</p>}
          {p.ocupado && (
            <p className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground px-1.5" data-testid="ocupado">
              <Loader2 size={14} className="animate-spin" /> {p.ocupado}
            </p>
          )}
          {p.erro && <p className="mt-2 text-xs text-red-600 px-1.5" role="alert" data-testid="erro">{p.erro}</p>}
        </section>
      </div>
    </div>
  );
}
