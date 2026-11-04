'use client';

/**
 * Passos CAD — desenho de coroa unitária no navegador do técnico.
 * Etapas: caso → preparo e margem → anatomia → ajustes → exportar. Só o laboratório abre.
 * Os arquivos do caso e as bibliotecas ficam neste computador: nada sobe para o servidor.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Download, FolderOpen, Loader2, RotateCcw, Trash2, Upload } from 'lucide-react';
import { Visor3D, type V3 } from './Visor3D';
import { ClienteDoMotor } from './motor/cliente';
import type { MalhaLeve } from './motor/worker';
import type { Ajuste, Parametros, Relatorio } from './motor/coroa';
import type { ResumoDente } from './motor/sessao';
import {
  apagarBiblioteca,
  bibliotecasGuardadas,
  chaveDoDente,
  denteDoFdi,
  guardarBiblioteca,
  indexarPasta,
  lerDenteGuardado,
} from './motor/biblioteca';
import type { BibliotecaDaPasta } from './motor/biblioteca-indice';
import { AJUSTES_DA_ANATOMIA, DENTES_FDI, ETAPAS, MAPAS, MATERIAIS, TEXTOS as T, type MapaId } from './textos';

interface CoroaNaTela {
  malha: MalhaLeve;
  espessura: Float32Array;
  folgaAntagonista: Float32Array;
  folgaVizinho: Float32Array;
  externos: number;
  relatorio: Relatorio;
}

const COR_ARCO = 0xcfc4ae;
const COR_ANT = 0x8d98a6;
const COR_DENTE = 0xf1ece0;

const faixa = (v: number, limites: [number, number[]][], fim: number[]): number[] => {
  for (const [lim, cor] of limites) if (v < lim) return cor;
  return fim;
};

const COR_NEUTRA = [0.95, 0.92, 0.85];

/** Cor por vértice da coroa conforme o mapa escolhido. */
function coresDoMapa(c: CoroaNaTela, mapa: MapaId, min: number): Float32Array | null {
  if (mapa === 'nenhum') return null;
  const n = c.malha.pos.length / 3;
  const cores = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    let cor = COR_NEUTRA;
    if (v < c.externos) {
      if (mapa === 'espessura') {
        const e = c.espessura[v];
        if (!Number.isNaN(e)) cor = faixa(e, [[min - 0.01, [0.85, 0.15, 0.12]], [min + 0.4, [0.95, 0.8, 0.2]], [min + 0.9, [0.3, 0.75, 0.35]]], [0.25, 0.5, 0.9]);
      } else if (mapa === 'antagonista') {
        const d = c.folgaAntagonista[v];
        if (!Number.isNaN(d)) cor = faixa(d, [[0, [0.85, 0.1, 0.1]], [0.15, [0.95, 0.45, 0.1]], [0.3, [0.95, 0.85, 0.2]], [0.5, [0.35, 0.75, 0.35]], [0.9, [0.3, 0.5, 0.9]]], COR_NEUTRA);
      } else {
        const d = c.folgaVizinho[v];
        if (!Number.isNaN(d)) cor = faixa(d, [[0, [0.85, 0.1, 0.1]], [0.06, [0.95, 0.45, 0.1]], [0.15, [0.95, 0.85, 0.2]], [0.4, [0.35, 0.75, 0.35]]], COR_NEUTRA);
      }
    }
    cores.set(cor, 3 * v);
  }
  return cores;
}

function baixar(dados: BlobPart, nome: string, tipo: string) {
  const url = URL.createObjectURL(new Blob([dados], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const Campo = ({ rotulo, ajuda, children }: { rotulo: string; ajuda?: string; children: ReactNode }) => (
  <label className="block">
    <span className="block text-xs font-semibold text-foreground mb-1">{rotulo}</span>
    {children}
    {ajuda && <span className="block text-[11px] text-muted-foreground mt-1">{ajuda}</span>}
  </label>
);

const BotaoArquivo = ({ rotulo, nome, aceitar, aoEscolher, testid }: { rotulo: string; nome: string | null; aceitar: string; aoEscolher: (f: File) => void; testid: string }) => (
  <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-background hover:bg-muted cursor-pointer text-sm">
    <Upload size={16} className="shrink-0" />
    <span className="truncate">{nome ?? rotulo}</span>
    <input
      type="file"
      data-testid={testid}
      accept={aceitar}
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) aoEscolher(f);
        e.target.value = '';
      }}
    />
  </label>
);

export default function PassosCadApp() {
  const caixa = useRef<HTMLDivElement | null>(null);
  const visor = useRef<Visor3D | null>(null);
  const motor = useRef<ClienteDoMotor | null>(null);
  const pastaRef = useRef<HTMLInputElement | null>(null);

  const [etapa, setEtapa] = useState(0);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [nomeCaso, setNomeCaso] = useState('');
  const [nomeArco, setNomeArco] = useState<string | null>(null);
  const [nomeAnt, setNomeAnt] = useState<string | null>(null);
  const [frenteDoArco, setFrenteDoArco] = useState<V3 | undefined>(undefined);
  const [fdi, setFdi] = useState<number | null>(null);
  const [materialId, setMaterialId] = useState(MATERIAIS[0].id);
  const [parametros, setParametros] = useState<Parametros>(MATERIAIS[0].parametros);

  const [dente, setDente] = useState<ResumoDente | null>(null);
  const [fixos, setFixos] = useState<V3[]>([]);

  const [pasta, setPasta] = useState<BibliotecaDaPasta<File>[]>([]);
  const [guardadas, setGuardadas] = useState<string[]>([]);
  const [nomeBib, setNomeBib] = useState<string | null>(null);
  const [ajuste, setAjuste] = useState<Ajuste | null>(null);

  const [coroa, setCoroa] = useState<CoroaNaTela | null>(null);
  const [mapa, setMapa] = useState<MapaId>('nenhum');
  const [verArco, setVerArco] = useState(true);
  const [verAnt, setVerAnt] = useState(false);

  useEffect(() => {
    if (!caixa.current) return undefined;
    const v = new Visor3D(caixa.current);
    const m = new ClienteDoMotor();
    visor.current = v;
    motor.current = m;
    void bibliotecasGuardadas().then(setGuardadas);
    return () => {
      v.encerrar();
      m.encerrar();
      visor.current = null;
      motor.current = null;
    };
  }, []);

  const executar = useCallback(async (msg: string, f: () => Promise<void>) => {
    setOcupado(msg);
    setErro(null);
    try {
      await f();
    } catch (e) {
      setErro(e instanceof Error ? e.message : T.erroGenerico);
    } finally {
      setOcupado(null);
    }
  }, []);

  const abrirArquivo = (qual: 'arco' | 'antagonista', f: File) =>
    executar(T.abrindoArquivo, async () => {
      const buf = await f.arrayBuffer();
      const m = await (motor.current as ClienteDoMotor).pedir<MalhaLeve>({ tipo: qual, nome: f.name, buf }, [buf]);
      const v = visor.current as Visor3D;
      if (qual === 'arco') {
        setNomeArco(f.name);
        setDente(null);
        setFixos([]);
        setAjuste(null);
        setCoroa(null);
        v.definirMalha('anatomia', null);
        v.definirMalha('coroa', null);
        v.definirLinha('margem', null, 0);
        v.definirMalha('arco', m, { cor: COR_ARCO });
        const frente = v.direcaoMedia(m);
        setFrenteDoArco(frente);
        v.enquadrar('arco', undefined, undefined, frente);
      } else {
        setNomeAnt(f.name);
        v.definirMalha('ant', m, { cor: COR_ANT, opacidade: 0.55 });
        v.definirVisivel('ant', verAnt);
      }
    });

  const desenharMargem = (r: ResumoDente) => {
    const v = visor.current as Visor3D;
    v.definirLinha('margem', r.margem as V3[], 0xff3b30);
    v.definirLinha('mesial', [r.O, [r.O[0] + r.mesial[0] * 7, r.O[1] + r.mesial[1] * 7, r.O[2] + r.mesial[2] * 7]], 0x34c759, false);
    v.definirLinha('vestibular', [r.O, [r.O[0] + r.vestibular[0] * 7, r.O[1] + r.vestibular[1] * 7, r.O[2] + r.vestibular[2] * 7]], 0x0a84ff, false);
  };

  // Clique na malha: 1ª etapa acha o preparo; depois cada clique é um ponto da margem.
  useEffect(() => {
    const v = visor.current;
    if (!v) return;
    if (etapa !== 1) {
      v.aoClicar = null;
      return;
    }
    v.aoClicar = (o, d) => {
      if (ocupado || !fdi) return;
      void executar(dente ? T.ajustandoMargem : T.procurandoPreparo, async () => {
        const m = motor.current as ClienteDoMotor;
        const h = await m.pedir<{ ponto: V3; normal: V3 } | null>({ tipo: 'apontar', o, d });
        if (!h) return;
        if (!dente) {
          const r = await m.pedir<ResumoDente>({ tipo: 'dente', fdi, clique: h.ponto, normal: h.normal });
          setDente(r);
          setFixos([]);
          desenharMargem(r);
          v.enquadrar(null, r.O, 11, r.a, r.vestibular);
        } else {
          const novos = [...fixos, h.ponto];
          const r = await m.pedir<ResumoDente>({ tipo: 'margem', fixos: novos as V3[] });
          setFixos(novos);
          setDente(r);
          desenharMargem(r);
          v.definirPontos('fixos', novos, 0xffd60a);
        }
      });
    };
  }, [etapa, fdi, dente, fixos, ocupado, executar]);

  const refazerMargem = (novos: V3[]) =>
    executar(T.ajustandoMargem, async () => {
      const r = await (motor.current as ClienteDoMotor).pedir<ResumoDente>({ tipo: 'margem', fixos: novos as V3[] });
      setFixos(novos);
      setDente(r);
      desenharMargem(r);
      (visor.current as Visor3D).definirPontos('fixos', novos, 0xffd60a);
    });

  const mostrarAnatomia = (m: MalhaLeve) => {
    const v = visor.current as Visor3D;
    v.definirMalha('anatomia', m, { cor: COR_DENTE, opacidade: 0.72 });
  };

  const usarDente = (nomeBiblioteca: string, nomeArq: string, buf: ArrayBuffer) =>
    executar(T.posicionandoDente, async () => {
      const r = await (motor.current as ClienteDoMotor).pedir<{ ajuste: Ajuste; malha: MalhaLeve }>(
        { tipo: 'anatomia', nome: nomeArq, buf, parametros },
        [buf],
      );
      setNomeBib(nomeBiblioteca);
      setAjuste(r.ajuste);
      setCoroa(null);
      (visor.current as Visor3D).definirMalha('coroa', null);
      mostrarAnatomia(r.malha);
    });

  const escolherGuardada = async (nome: string) => {
    if (!fdi) return;
    const { arcada, posicao } = denteDoFdi(fdi);
    const d = await lerDenteGuardado(nome, chaveDoDente(arcada, posicao));
    if (!d) {
      setErro(T.bibliotecaSemDente);
      return;
    }
    await usarDente(nome, d.nome, d.dados);
  };

  const aoEscolherPasta = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setPasta(indexarPasta(e.target.files));
    e.target.value = '';
  };

  const escolherDaPasta = (nome: string) =>
    executar(T.guardandoBiblioteca, async () => {
      const b = pasta.find((x) => x.nome === nome);
      if (!b) return;
      await guardarBiblioteca(b);
      setGuardadas(await bibliotecasGuardadas());
      await escolherGuardada(nome);
    });

  const moverAnatomia = (novo: Ajuste) => {
    setAjuste(novo);
    setCoroa(null);
    (visor.current as Visor3D).definirMalha('coroa', null);
    void (motor.current as ClienteDoMotor).pedir<MalhaLeve>({ tipo: 'mover', ajuste: novo, parametros }).then(mostrarAnatomia).catch(() => undefined);
  };

  const gerarCoroa = () =>
    executar(T.gerandoCoroa, async () => {
      if (!ajuste) return;
      const c = await (motor.current as ClienteDoMotor).pedir<CoroaNaTela>({ tipo: 'coroa', ajuste, parametros });
      setCoroa(c);
      const v = visor.current as Visor3D;
      v.definirMalha('anatomia', null);
      v.definirMalha('coroa', { pos: c.malha.pos, tri: c.malha.tri, cores: coresDoMapa(c, mapa, parametros.espessuraMinima) ?? undefined }, { cor: COR_DENTE });
      v.definirLinha('margem', null, 0);
      v.definirLinha('mesial', null, 0);
      v.definirLinha('vestibular', null, 0);
      v.definirPontos('fixos', null, 0);
      setEtapa(3);
    });

  useEffect(() => {
    if (coroa) visor.current?.definirCores('coroa', coresDoMapa(coroa, mapa, parametros.espessuraMinima), COR_DENTE);
  }, [coroa, mapa, parametros.espessuraMinima]);
  useEffect(() => visor.current?.definirVisivel('arco', verArco), [verArco]);
  useEffect(() => visor.current?.definirVisivel('ant', verAnt), [verAnt]);

  const exportar = () =>
    executar(T.exportando, async () => {
      const b = await (motor.current as ClienteDoMotor).pedir<ArrayBuffer>({ tipo: 'stl' });
      const base = (nomeCaso.trim() || T.nomePadraoCaso).replace(/[^\p{L}\p{N}_-]+/gu, '-');
      baixar(b, `${base}-coroa-${fdi}.stl`, 'model/stl');
    });

  const podeAvancar = useMemo(() => {
    if (etapa === 0) return Boolean(nomeArco && fdi);
    if (etapa === 1) return Boolean(dente);
    if (etapa === 2) return Boolean(ajuste);
    if (etapa === 3) return Boolean(coroa);
    return false;
  }, [etapa, nomeArco, fdi, dente, ajuste, coroa]);

  const avancar = () => {
    if (etapa === 2) {
      void gerarCoroa();
      return;
    }
    setEtapa(etapa + 1);
  };

  const r = coroa?.relatorio;
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-border bg-background text-sm';

  return (
    <div className="h-full flex flex-col md:flex-row min-h-0" data-testid="passos-cad">
      <aside className="w-full md:w-[340px] shrink-0 border-r border-border bg-card flex flex-col min-h-0">
        <div className="px-4 pt-4 pb-3 border-b border-border">
          <h1 className="text-lg font-bold text-foreground">{T.titulo}</h1>
          <p className="text-xs text-muted-foreground">{T.subtitulo}</p>
          <ol className="flex gap-1 mt-3">
            {ETAPAS.map((nome, i) => (
              <li key={nome} className={`flex-1 h-1.5 rounded-full ${i <= etapa ? 'bg-primary' : 'bg-muted'}`} title={nome} />
            ))}
          </ol>
          <p className="text-xs font-semibold text-foreground mt-2">{`${etapa + 1}. ${ETAPAS[etapa]}`}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {etapa === 0 && (
            <>
              <Campo rotulo={T.nomeCaso}>
                <input className={inputCls} value={nomeCaso} onChange={(e) => setNomeCaso(e.target.value)} placeholder={T.nomeCasoExemplo} />
              </Campo>
              <Campo rotulo={T.arcoPreparo}>
                <BotaoArquivo testid="arquivo-arco" rotulo={T.escolherArquivo} nome={nomeArco} aceitar=".stl,.obj,.ply" aoEscolher={(f) => void abrirArquivo('arco', f)} />
              </Campo>
              <Campo rotulo={T.arcoAntagonista} ajuda={T.antagonistaAjuda}>
                <BotaoArquivo testid="arquivo-antagonista" rotulo={T.escolherArquivo} nome={nomeAnt} aceitar=".stl,.obj,.ply" aoEscolher={(f) => void abrirArquivo('antagonista', f)} />
              </Campo>
              <Campo rotulo={T.dente}>
                <div className="grid grid-cols-8 gap-1">
                  {DENTES_FDI.map((n) => (
                    <button
                      key={n}
                      type="button"
                      data-testid={`dente-${n}`}
                      onClick={() => setFdi(n)}
                      className={`py-1 rounded text-xs font-semibold border ${fdi === n ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </Campo>
              <Campo rotulo={T.material}>
                <select
                  className={inputCls}
                  value={materialId}
                  onChange={(e) => {
                    setMaterialId(e.target.value);
                    const m = MATERIAIS.find((x) => x.id === e.target.value);
                    if (m) setParametros(m.parametros);
                  }}
                >
                  {MATERIAIS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.nome}
                    </option>
                  ))}
                </select>
              </Campo>
            </>
          )}

          {etapa === 1 && (
            <>
              <p className="text-sm text-foreground">{dente ? T.margemInstrucao : T.clicarPreparo}</p>
              {dente && (
                <>
                  <p className="text-[11px] text-muted-foreground">{T.legendaEixos}</p>
                  <div className="flex gap-2">
                    <button type="button" disabled={!fixos.length || Boolean(ocupado)} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-2 rounded-lg border border-border text-xs disabled:opacity-40" onClick={() => void refazerMargem(fixos.slice(0, -1))}>
                      <RotateCcw size={14} /> {T.desfazerPonto}
                    </button>
                    <button type="button" disabled={!fixos.length || Boolean(ocupado)} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-2 rounded-lg border border-border text-xs disabled:opacity-40" onClick={() => void refazerMargem([])}>
                      <Trash2 size={14} /> {T.limparPontos}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="w-full px-2 py-2 rounded-lg border border-border text-xs"
                    onClick={() => {
                      setDente(null);
                      setFixos([]);
                      const v = visor.current as Visor3D;
                      v.definirLinha('margem', null, 0);
                      v.definirLinha('mesial', null, 0);
                      v.definirLinha('vestibular', null, 0);
                      v.definirPontos('fixos', null, 0);
                      v.enquadrar('arco', undefined, undefined, frenteDoArco);
                    }}
                  >
                    {T.clicarDeNovo}
                  </button>
                </>
              )}
            </>
          )}

          {etapa === 2 && (
            <>
              <Campo rotulo={T.bibliotecaGuardada} ajuda={T.bibliotecaAjuda}>
                <select className={inputCls} data-testid="biblioteca-guardada" value={guardadas.includes(nomeBib ?? '') ? (nomeBib as string) : ''} onChange={(e) => e.target.value && void executar(T.posicionandoDente, () => escolherGuardada(e.target.value))}>
                  <option value="">{guardadas.length ? T.escolha : T.nenhumaGuardada}</option>
                  {guardadas.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Campo>
              {nomeBib && guardadas.includes(nomeBib) && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() =>
                    void executar(T.guardandoBiblioteca, async () => {
                      await apagarBiblioteca(nomeBib);
                      setGuardadas(await bibliotecasGuardadas());
                    })
                  }
                >
                  {T.tirarBiblioteca}
                </button>
              )}
              <button type="button" onClick={() => pastaRef.current?.click()} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted">
                <FolderOpen size={16} /> {T.escolherPasta}
              </button>
              <input ref={pastaRef} type="file" data-testid="pasta-biblioteca" className="hidden" multiple onChange={aoEscolherPasta} {...({ webkitdirectory: '' } as Record<string, string>)} />
              {pasta.length > 0 && (
                <Campo rotulo={T.bibliotecasDaPasta}>
                  <select className={inputCls} data-testid="biblioteca-pasta" value="" onChange={(e) => e.target.value && void escolherDaPasta(e.target.value)}>
                    <option value="">{T.escolha}</option>
                    {pasta.map((b) => (
                      <option key={b.nome} value={b.nome} disabled={!b.dentes.size}>
                        {b.dentes.size ? b.nome : `${b.nome} ${T.protegidaSufixo}`}
                      </option>
                    ))}
                  </select>
                </Campo>
              )}
              <Campo rotulo={T.denteSolto} ajuda={T.denteSoltoAjuda}>
                <BotaoArquivo
                  testid="arquivo-dente"
                  rotulo={T.escolherArquivo}
                  nome={null}
                  aceitar=".stl,.obj,.ply,.eoff"
                  aoEscolher={(f) => void f.arrayBuffer().then((b) => usarDente(f.name, f.name, b))}
                />
              </Campo>
              {ajuste && (
                <div className="space-y-3 pt-2 border-t border-border">
                  {AJUSTES_DA_ANATOMIA.map((c) => (
                    <label key={c.chave} className="block">
                      <span className="flex justify-between text-xs">
                        <span className="font-semibold">{c.rotulo}</span>
                        <span className="text-muted-foreground">{ajuste[c.chave].toFixed(c.casas)}{c.unidade}</span>
                      </span>
                      <input type="range" className="w-full" min={c.min} max={c.max} step={c.passo} value={ajuste[c.chave]} onChange={(e) => moverAnatomia({ ...ajuste, [c.chave]: +e.target.value })} />
                    </label>
                  ))}
                  <button
                    type="button"
                    className="w-full inline-flex items-center justify-center gap-1 px-2 py-2 rounded-lg border border-border text-xs"
                    onClick={() =>
                      void executar(T.posicionandoDente, async () => {
                        const res = await (motor.current as ClienteDoMotor).pedir<{ ajuste: Ajuste; malha: MalhaLeve }>({ tipo: 'reposicionar', parametros });
                        setAjuste(res.ajuste);
                        mostrarAnatomia(res.malha);
                      })
                    }
                  >
                    <RotateCcw size={14} /> {T.posicaoAutomatica}
                  </button>
                </div>
              )}
            </>
          )}

          {etapa === 3 && coroa && r && (
            <>
              <Campo rotulo={T.mapa}>
                <select className={inputCls} data-testid="mapa" value={mapa} onChange={(e) => setMapa(e.target.value as MapaId)}>
                  {MAPAS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.nome}
                    </option>
                  ))}
                </select>
              </Campo>
              <div className="flex gap-3 text-xs">
                <label className="inline-flex items-center gap-1"><input type="checkbox" checked={verArco} onChange={(e) => setVerArco(e.target.checked)} /> {T.verArco}</label>
                {nomeAnt && <label className="inline-flex items-center gap-1"><input type="checkbox" checked={verAnt} onChange={(e) => setVerAnt(e.target.checked)} /> {T.verAntagonista}</label>}
              </div>
              <div className="space-y-2 pt-2 border-t border-border">
                {([
                  ['cimento', T.pCimento],
                  ['inicioCimento', T.pInicioCimento],
                  ['espessuraMinima', T.pEspessura],
                  ['folgaAntagonista', T.pAntagonista],
                  ['folgaVizinho', T.pVizinho],
                ] as const).map(([chave, rotulo]) => (
                  <label key={chave} className="flex items-center justify-between gap-2 text-xs">
                    <span>{rotulo}</span>
                    <input type="number" step={0.01} min={0} className="w-20 px-2 py-1 rounded border border-border bg-background text-right" value={parametros[chave]} onChange={(e) => setParametros({ ...parametros, [chave]: +e.target.value })} />
                  </label>
                ))}
                <button type="button" onClick={() => void gerarCoroa()} className="w-full inline-flex items-center justify-center gap-1 px-2 py-2 rounded-lg border border-border text-xs">
                  <RotateCcw size={14} /> {T.recalcular}
                </button>
              </div>
              <dl className="text-xs grid grid-cols-2 gap-x-3 gap-y-1 pt-2 border-t border-border" data-testid="relatorio">
                <dt className="text-muted-foreground">{T.rTamanho}</dt>
                <dd className="text-right">{`${r.mdMm} × ${r.vlMm} × ${r.alturaMm} mm`}</dd>
                <dt className="text-muted-foreground">{T.rEspOclusal}</dt>
                <dd className="text-right">{r.espessuraOclusal ? `${r.espessuraOclusal.p5} / ${r.espessuraOclusal.mediana} mm` : '—'}</dd>
                <dt className="text-muted-foreground">{T.rContatoAnt}</dt>
                <dd className="text-right">{nomeAnt ? r.regioesContatoAntagonista : '—'}</dd>
                <dt className="text-muted-foreground">{T.rContatoViz}</dt>
                <dd className="text-right">{r.regioesContatoVizinho}</dd>
                <dt className="text-muted-foreground">{T.rMalha}</dt>
                <dd className="text-right">{r.malha.arestasAbertas === 0 && r.malha.arestasRepetidas === 0 ? T.rMalhaOk : T.rMalhaRuim}</dd>
              </dl>
              {nomeAnt && r.espessuraOclusal && r.espessuraOclusal.p5 > 2 && <p className="text-xs text-amber-600" data-testid="aviso-alta">{T.avisoAlta}</p>}
              {r.conflitosEspessura > 0 && <p className="text-xs text-amber-600">{T.avisoConflito}</p>}
              {r.retencoesPreenchidas > 0 && <p className="text-xs text-amber-600">{T.avisoRetencao}</p>}
            </>
          )}

          {etapa === 4 && coroa && (
            <>
              <p className="text-sm">{T.exportarTexto}</p>
              <button type="button" data-testid="baixar-stl" onClick={() => void exportar()} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold">
                <Download size={16} /> {T.baixarStl}
              </button>
              <p className="text-xs text-amber-600">{T.avisoRevisao}</p>
            </>
          )}

          {erro && <p className="text-xs text-red-600" role="alert" data-testid="erro">{erro}</p>}
        </div>

        <div className="p-3 border-t border-border flex gap-2">
          <button type="button" disabled={etapa === 0 || Boolean(ocupado)} onClick={() => setEtapa(etapa - 1)} className="px-3 py-2 rounded-lg border border-border text-sm inline-flex items-center gap-1 disabled:opacity-40">
            <ChevronLeft size={16} /> {T.voltar}
          </button>
          {etapa < 4 && (
            <button type="button" data-testid="avancar" disabled={!podeAvancar || Boolean(ocupado)} onClick={avancar} className="flex-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center justify-center gap-1 disabled:opacity-40">
              {etapa === 2 ? T.gerar : T.avancar} <ChevronRight size={16} />
            </button>
          )}
        </div>
      </aside>

      <div className="relative flex-1 min-h-[360px]">
        <div ref={caixa} className="absolute inset-0" data-testid="visor" />
        {ocupado && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/70 text-white text-xs inline-flex items-center gap-2" data-testid="ocupado">
            <Loader2 size={14} className="animate-spin" /> {ocupado}
          </div>
        )}
      </div>
    </div>
  );
}
