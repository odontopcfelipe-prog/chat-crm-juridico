'use client';

/**
 * Passos CAD — desenho de coroa unitária no navegador do técnico.
 * Etapas: caso → preparo e margem → anatomia → ajustes → exportar. Só o laboratório abre.
 * Os arquivos do caso ficam neste computador: nada sobe para o servidor. A anatomia vem do desenho
 * de partida do motor ou do plano da IA; importar biblioteca de outro CAD saiu (os termos dela só
 * permitem o uso dentro do CAD de origem).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Focus, Loader2, RotateCcw, Sparkles, Trash2, Upload } from 'lucide-react';
import { Visor3D, type V3 } from './Visor3D';
import { ClienteDoMotor } from './motor/cliente';
import { Campo, CampoDeBroca, brocaLembrada } from './campos';
import { pedirDesenhoIa } from './desenho-com-ia';
import { fichaNova, guardarRecentes, lerRecentes, type FichaCaso, type Recentes } from './ficha';
import { apagarBibliotecaAntiga } from './motor/conta';
import { FichaDoCaso } from './FichaDoCaso';
import type { MalhaLeve } from './motor/worker';
import type { FimDoTraco, MedidasDaCoroa, ModoPincel, MudancaDaMalha, OpcoesPincel, RespostaDoPincel } from './motor/escultura';
import type { Parametros, Relatorio } from './motor/coroa';
import type { ResumoDente } from './motor/sessao';
import { planoPadrao, validarPlano, type PedidoDesenhoIa, type PlanoDoDente } from './motor/plano-do-dente';
import { ETAPAS, MAPAS, MATERIAIS, PINCEIS, TEXTOS as T, type MapaId } from './textos';

interface CoroaNaTela {
  malha: MalhaLeve;
  espessura: Float32Array;
  espessuraPedida: Float32Array;
  folgaAntagonista: Float32Array;
  folgaVizinho: Float32Array;
  corteFresa: Float32Array;
  externos: number;
  relatorio: Relatorio;
  /** A folga do vizinho com que esta coroa foi gerada; o campo na tela pode já ter mudado. */
  folgaVizinhoUsada?: number;
}

const COR_ARCO = 0xcfc4ae;
const COR_ANT = 0x8d98a6;
const COR_DENTE = 0xf1ece0;
const COR_PONTO = 0xffd60a;
const COR_PINCEL = 0x0a84ff;
/** Medir é demorado: espera o técnico parar de esculpir. */
const PAUSA_PARA_MEDIR_MS = 350;
const TAMANHO_MAXIMO = 400 * 1024 * 1024;

/** Número em português: 0,09 e não 0.09. */
const nr = (x: number): string => String(x).replace('.', ',');

const faixa = (v: number, limites: [number, number[]][], fim: number[]): number[] => {
  for (const [lim, cor] of limites) if (v < lim) return cor;
  return fim;
};

const COR_NEUTRA = [0.95, 0.92, 0.85];

/** Acima disto a parede afina demais para passar sem aviso. */
const CORTE_GRANDE_DA_BROCA = 0.3;
/** Cor por vértice da coroa conforme o mapa escolhido. */
function coresDoMapa(c: CoroaNaTela, mapa: MapaId): Float32Array | null {
  if (mapa === 'nenhum') return null;
  const n = c.malha.pos.length / 3;
  const cores = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    let cor = COR_NEUTRA;
    if (mapa === 'broca') {
      const q = c.corteFresa[v];
      if (q >= 0.005) cor = faixa(q, [[0.05, [0.35, 0.75, 0.35]], [0.15, [0.95, 0.85, 0.2]], [CORTE_GRANDE_DA_BROCA, [0.95, 0.45, 0.1]]], [0.85, 0.1, 0.1]);
    } else if (v < c.externos) {
      if (mapa === 'espessura') {
        const e = c.espessura[v];
        // O mínimo muda de um ponto para outro: mais na oclusal, menos na parede e quase nada na margem.
        const min = c.espessuraPedida[v];
        if (!Number.isNaN(e)) cor = faixa(e, [[min - 0.01, [0.85, 0.15, 0.12]], [min + 0.4, [0.95, 0.8, 0.2]], [min + 0.9, [0.3, 0.75, 0.35]]], [0.25, 0.5, 0.9]);
      } else if (mapa === 'antagonista') {
        const d = c.folgaAntagonista[v];
        // Vermelho é interferência; laranja, contato; verde e azul, o que está perto de encostar.
        if (!Number.isNaN(d)) cor = faixa(d, [[0, [0.85, 0.1, 0.1]], [0.05, [0.95, 0.45, 0.1]], [0.15, [0.35, 0.75, 0.35]], [0.3, [0.3, 0.5, 0.9]]], COR_NEUTRA);
      } else {
        const d = c.folgaVizinho[v];
        // A sobreposição pedida não é erro: vermelho só quando entra além dela.
        if (!Number.isNaN(d)) cor = faixa(d, [[Math.min(0, c.folgaVizinhoUsada ?? 0) - 0.02, [0.85, 0.1, 0.1]], [0.05, [0.95, 0.45, 0.1]], [0.15, [0.95, 0.85, 0.2]], [0.4, [0.35, 0.75, 0.35]]], COR_NEUTRA);
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

const BotaoArquivo = ({ rotulo, nome, aceitar, aoEscolher, testid, travado }: { rotulo: string; nome: string | null; aceitar: string; aoEscolher: (f: File) => void; testid: string; travado: boolean }) => (
  <label className={`relative flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-background text-sm focus-within:outline focus-within:outline-2 focus-within:outline-primary ${travado ? 'opacity-50' : 'hover:bg-muted cursor-pointer'}`}>
    <Upload size={16} className="shrink-0" />
    <span className="truncate">{nome ?? rotulo}</span>
    <input
      type="file"
      data-testid={testid}
      accept={aceitar}
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

export default function PassosCadApp() {
  const caixa = useRef<HTMLDivElement | null>(null);
  const visor = useRef<Visor3D | null>(null);
  const motor = useRef<ClienteDoMotor | null>(null);

  const [etapa, setEtapa] = useState(0);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recentes, setRecentes] = useState<Recentes>(lerRecentes);
  const [ficha, setFicha] = useState<FichaCaso>(() => fichaNova(lerRecentes().tecnicos[0] ?? ''));
  const [nomeArco, setNomeArco] = useState<string | null>(null);
  const [nomeAnt, setNomeAnt] = useState<string | null>(null);
  const [frenteDoArco, setFrenteDoArco] = useState<V3 | undefined>(undefined);
  const [fdi, setFdi] = useState<number | null>(null);
  const [materialId, setMaterialId] = useState(MATERIAIS[0].id);
  const [parametros, setParametros] = useState<Parametros>(() => ({
    ...MATERIAIS[0].parametros,
    diametroBroca: brocaLembrada(MATERIAIS[0].parametros.diametroBroca),
  }));

  const [dente, setDente] = useState<ResumoDente | null>(null);
  const [fixos, setFixos] = useState<V3[]>([]);

  // Plano da coroa na tela: quem muda os ajustes gera de novo pelo mesmo plano, sem gastar crédito.
  const [plano, setPlano] = useState<{ desenho: PlanoDoDente; origem: 'ia' | 'base' } | null>(null);

  const [coroa, setCoroa] = useState<CoroaNaTela | null>(null);
  const [mapa, setMapa] = useState<MapaId>('nenhum');
  const [verArco, setVerArco] = useState(true);
  const [verAnt, setVerAnt] = useState(false);

  const [pincel, setPincel] = useState<ModoPincel | null>(null);
  const [tamanhoPincel, setTamanhoPincel] = useState(1.5);
  const [forcaPincel, setForcaPincel] = useState(0.5);
  const [tracos, setTracos] = useState(0);
  const [medindo, setMedindo] = useState(false);
  const [noLimite, setNoLimite] = useState(false);
  const [entrou, setEntrou] = useState({ vizinho: false, antagonista: false });
  const relogioDeMedida = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tracando = useRef(false);
  const faltaMedir = useRef(false);

  useEffect(() => {
    if (!caixa.current) return undefined;
    const v = new Visor3D(caixa.current);
    const m = new ClienteDoMotor();
    visor.current = v;
    motor.current = m;
    apagarBibliotecaAntiga();
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

  /** A coroa e a posição do dente dependem da margem: mudou a margem, elas saem. */
  const zerarEscultura = useCallback(() => {
    if (relogioDeMedida.current) clearTimeout(relogioDeMedida.current);
    relogioDeMedida.current = null;
    faltaMedir.current = false;
    tracando.current = false;
    setPincel(null);
    setTracos(0);
    setMedindo(false);
    setNoLimite(false);
    setEntrou({ vizinho: false, antagonista: false });
  }, []);

  const descartarCoroa = useCallback(() => {
    setPlano(null);
    setCoroa(null);
    zerarEscultura();
    const v = visor.current;
    v?.definirMalha('anatomia', null);
    v?.definirMalha('coroa', null);
  }, [zerarEscultura]);

  /** Volta ao clique no preparo: arcada, antagonista ou dente mudaram, nada do caso anterior vale. */
  const descartarDente = useCallback(() => {
    descartarCoroa();
    setDente(null);
    setFixos([]);
    const v = visor.current;
    v?.definirLinha('margem', null, 0);
    v?.definirLinha('mesial', null, 0);
    v?.definirLinha('vestibular', null, 0);
    v?.definirPontos('fixos', null, 0);
  }, [descartarCoroa]);

  const abrirArquivo = (qual: 'arco' | 'antagonista', f: File) =>
    executar(T.abrindoArquivo, async () => {
      if (f.size > TAMANHO_MAXIMO) throw new Error(T.arquivoGrande);
      const buf = await f.arrayBuffer();
      const m = await (motor.current as ClienteDoMotor).pedir<MalhaLeve>({ tipo: qual, nome: f.name, buf }, [buf]);
      const v = visor.current as Visor3D;
      descartarDente();
      if (qual === 'arco') {
        setNomeArco(f.name);
        v.definirMalha('arco', m, { cor: COR_ARCO });
        const frente = v.direcaoMedia(m);
        setFrenteDoArco(frente);
        v.enquadrar('arco', undefined, undefined, frente);
      } else {
        setNomeAnt(f.name);
        v.definirMalha('ant', m, { cor: COR_ANT, opacidade: 0.55 });
        v.definirVisivel('ant', false);
      }
    });

  // O aviso é da etapa em que aconteceu.
  useEffect(() => setErro(null), [etapa]);

  // Na etapa da margem: a linha e os pontos à vista, sem o dente na frente do preparo.
  useEffect(() => {
    const v = visor.current;
    if (!v) return;
    v.definirVisivel('coroa', etapa !== 1);
    v.definirVisivel('anatomia', etapa !== 1);
    if (etapa !== 1 || !dente) return;
    v.definirLinha('margem', dente.margem as V3[], 0xff3b30);
    v.definirLinha('mesial', [dente.O, [dente.O[0] + dente.mesial[0] * 7, dente.O[1] + dente.mesial[1] * 7, dente.O[2] + dente.mesial[2] * 7]], 0x34c759, false);
    v.definirLinha('vestibular', [dente.O, [dente.O[0] + dente.vestibular[0] * 7, dente.O[1] + dente.vestibular[1] * 7, dente.O[2] + dente.vestibular[2] * 7]], 0x0a84ff, false);
    v.definirPontos('fixos', fixos, COR_PONTO);
  }, [etapa, dente, fixos]);

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
          v.enquadrar(null, r.O, 11, r.a, r.vestibular);
        } else {
          const novos = [...fixos, h.ponto];
          const r = await m.pedir<ResumoDente>({ tipo: 'margem', fixos: novos as V3[] });
          descartarCoroa();
          setFixos(novos);
          setDente(r);
        }
      });
    };
  }, [etapa, fdi, dente, fixos, ocupado, executar, descartarCoroa]);

  const refazerMargem = (novos: V3[]) =>
    executar(T.ajustandoMargem, async () => {
      const r = await (motor.current as ClienteDoMotor).pedir<ResumoDente>({ tipo: 'margem', fixos: novos as V3[] });
      descartarCoroa();
      setFixos(novos);
      setDente(r);
    });

  /** Volta para a vista do dente (ou da arcada): girando de perto, é fácil se perder no modelo. */
  const centralizarVista = () => {
    const v = visor.current;
    if (!v) return;
    if (dente) v.enquadrar(null, dente.O, 11, dente.a, dente.vestibular);
    else v.enquadrar('arco', undefined, undefined, frenteDoArco);
  };

  /** O corte da broca está no lado de dentro: mostra por baixo, sem a arcada na frente. */
  const verPorDentro = () => {
    const v = visor.current;
    if (!v || !dente) return;
    setVerArco(false);
    v.enquadrar(null, dente.O, 7, [-dente.a[0], -dente.a[1], -dente.a[2]], dente.vestibular);
  };

  const mostrarCoroa = (recebida: CoroaNaTela) => {
      const c = { ...recebida, folgaVizinhoUsada: parametros.folgaVizinho };
      zerarEscultura();
      setCoroa(c);
      const v = visor.current as Visor3D;
      v.definirMalha('anatomia', null);
      v.definirMalha('coroa', { pos: c.malha.pos, tri: c.malha.tri, cores: coresDoMapa(c, mapa) ?? undefined }, { cor: COR_DENTE });
      v.definirLinha('margem', null, 0);
      v.definirLinha('mesial', null, 0);
      v.definirLinha('vestibular', null, 0);
      v.definirPontos('fixos', null, 0);
      setEtapa(3);
  };

  const gerarCoroa = () =>
    executar(T.gerandoCoroa, async () => {
      const m = motor.current as ClienteDoMotor;
      if (plano) mostrarCoroa(await m.pedir<CoroaNaTela>({ tipo: 'coroaDoPlano', plano: plano.desenho, parametros }));
    });

  /** Sem IA, o plano é o desenho de partida do dente: não sai nada do computador. */
  const desenharPeloPlano = (usarIa: boolean) =>
    executar(usarIa ? T.iaMedindo : T.gerandoCoroa, async () => {
      if (!fdi) return;
      const m = motor.current as ClienteDoMotor;
      let desenho = planoPadrao(fdi);
      if (usarIa) {
        const quadro = await m.pedir<PedidoDesenhoIa>({ tipo: 'quadroIa', parametros });
        setOcupado(T.iaPensando);
        try {
          desenho = validarPlano(await pedirDesenhoIa(quadro), fdi);
        } catch (e) {
          throw new Error((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? T.iaErro);
        }
        setOcupado(T.gerandoCoroa);
      }
      // Guarda antes de construir: se o motor falhar, gerar de novo não gasta outra chamada à IA.
      setPlano({ desenho, origem: usarIa ? 'ia' : 'base' });
      mostrarCoroa(await m.pedir<CoroaNaTela>({ tipo: 'coroaDoPlano', plano: desenho, parametros }));
    });

  useEffect(() => {
    if (coroa) visor.current?.definirCores('coroa', coresDoMapa(coroa, mapa), COR_DENTE);
  }, [coroa, mapa]);
  // Esconder arcada ou mostrar antagonista é da conferência; antes disso atrapalharia o clique.
  useEffect(() => visor.current?.definirVisivel('arco', verArco || etapa < 3), [verArco, etapa]);
  useEffect(() => visor.current?.definirVisivel('ant', verAnt && etapa >= 3), [verAnt, etapa]);

  // ---------- pincel ----------

  /** Mede em pedaços; se o técnico voltar a esculpir, para e retoma na próxima pausa. */
  const medirNaPausa = useCallback(() => {
    if (relogioDeMedida.current) clearTimeout(relogioDeMedida.current);
    faltaMedir.current = true;
    setMedindo(true);
    const passo = () => {
      if (tracando.current || !faltaMedir.current) return;
      (motor.current as ClienteDoMotor)
        .pedir<MedidasDaCoroa | null>({ tipo: 'pincelMedir' })
        .then((r) => {
          // O caso mudou enquanto media: esta resposta é do anterior.
          if (!faltaMedir.current) return;
          if (!r) {
            passo();
            return;
          }
          setCoroa((c) => c && { ...c, espessura: r.espessura, folgaAntagonista: r.folgaAntagonista, folgaVizinho: r.folgaVizinho, relatorio: r.relatorio });
          setEntrou({ vizinho: r.entrouNoVizinho, antagonista: r.entrouNoAntagonista });
          faltaMedir.current = false;
          setMedindo(false);
        })
        .catch((e: unknown) => {
          if (!faltaMedir.current) return;
          faltaMedir.current = false;
          setMedindo(false);
          setErro(e instanceof Error ? e.message : T.erroGenerico);
        });
    };
    relogioDeMedida.current = setTimeout(passo, PAUSA_PARA_MEDIR_MS);
  }, []);

  const temCoroa = Boolean(coroa);
  const calculando = Boolean(ocupado);
  useEffect(() => {
    const v = visor.current;
    const m = motor.current;
    if (!v || !m) return undefined;
    // Enquanto gera a coroa, a que está na tela já não é a do motor.
    const ativo = etapa === 3 && temCoroa && pincel !== null && !calculando;
    v.definirModoPincel(ativo);
    if (!ativo || !pincel) {
      v.aoPincel = null;
      v.definirLinha('mira', null, 0);
      return undefined;
    }
    const opcoes: OpcoesPincel = { modo: pincel, raio: tamanhoPincel, forca: forcaPincel };
    const falhou = (e: unknown) => setErro(e instanceof Error ? e.message : T.erroGenerico);
    const anel = (c: V3 | null, n: V3 | null) => {
      if (c && n) v.definirAnel('mira', c, n, opcoes.raio, COR_PINCEL);
      else v.definirLinha('mira', null, 0);
    };
    // Um pedido por vez, na ordem: o que chega enquanto o motor trabalha vai junto no próximo,
    // sem nunca juntar dois traços. Cada traço tem o seu desfazer.
    type Item = { raio: [V3, V3]; inicio: boolean } | { fim: true };
    const fila: Item[] = [];
    let voando = false;
    let abertos = 0;
    let segurando = false;
    let miraNova: [V3, V3] | null = null;
    let miraVoando = false;
    const fechouTraco = () => {
      abertos--;
      tracando.current = abertos > 0;
    };
    const enviar = () => {
      if (voando || !fila.length) return;
      voando = true;
      const seguir = () => {
        voando = false;
        enviar();
      };
      const primeiro = fila[0];
      if ('fim' in primeiro) {
        fila.shift();
        m.pedir<FimDoTraco | null>({ tipo: 'pincelFim' })
          .then((r) => {
            fechouTraco();
            if (!r) {
              // Clique fora da coroa no meio de uma medição: retoma o que faltava.
              if (faltaMedir.current) medirNaPausa();
              return;
            }
            setTracos(r.tracos);
            setNoLimite(r.noLimite);
            medirNaPausa();
          })
          .catch((e: unknown) => {
            fechouTraco();
            faltaMedir.current = false;
            setMedindo(false);
            falhou(e);
          })
          .finally(seguir);
        return;
      }
      const raios: [V3, V3][] = [];
      while (fila.length) {
        const item = fila[0];
        if ('fim' in item || (raios.length > 0 && item.inicio)) break;
        raios.push(item.raio);
        fila.shift();
      }
      m.pedir<RespostaDoPincel>({ tipo: 'pincel', raios, opcoes, inicio: primeiro.inicio })
        .then((r) => {
          if (r.mudanca) v.atualizarMalha('coroa', r.mudanca);
          anel(r.centro, r.normal);
        })
        .catch(falhou)
        .finally(seguir);
    };
    const pedirMira = () => {
      if (miraVoando || !miraNova || tracando.current) return;
      const [o, d] = miraNova;
      miraNova = null;
      miraVoando = true;
      m.pedir<{ centro: V3; normal: V3 } | null>({ tipo: 'mira', o, d })
        .then((r) => {
          if (!tracando.current) anel(r?.centro ?? null, r?.normal ?? null);
        })
        .catch(() => undefined)
        .finally(() => {
          miraVoando = false;
          pedirMira();
        });
    };
    const soltar = () => {
      segurando = false;
      fila.push({ fim: true });
      enviar();
    };
    v.aoPincel = {
      inicio: (o, d) => {
        segurando = true;
        abertos++;
        tracando.current = true;
        if (relogioDeMedida.current) clearTimeout(relogioDeMedida.current);
        setErro(null);
        fila.push({ raio: [o, d], inicio: true });
        enviar();
      },
      mover: (o, d) => {
        fila.push({ raio: [o, d], inicio: false });
        enviar();
      },
      fim: soltar,
      mira: (o, d) => {
        miraNova = [o, d];
        pedirMira();
      },
      saiu: () => {
        miraNova = null;
        anel(null, null);
      },
    };
    return () => {
      v.aoPincel = null;
      // A tela mudou com o botão apertado: o traço termina aqui.
      if (segurando) soltar();
    };
  }, [etapa, temCoroa, calculando, pincel, tamanhoPincel, forcaPincel, medirNaPausa]);

  const desfazerTraco = () =>
    executar(T.desfazendoTraco, async () => {
      const r = await (motor.current as ClienteDoMotor).pedir<{ mudanca: MudancaDaMalha; tracos: number } | null>({ tipo: 'pincelDesfazer' });
      if (!r) return;
      (visor.current as Visor3D).atualizarMalha('coroa', r.mudanca);
      setTracos(r.tracos);
      setNoLimite(false);
      medirNaPausa();
    });

  const exportar = () =>
    executar(T.exportando, async () => {
      const b = await (motor.current as ClienteDoMotor).pedir<ArrayBuffer>({ tipo: 'stl' });
      // Só o número do caso: o nome do paciente do caso não vai no nome do arquivo.
      const base = (ficha.numero.trim() || T.nomePadraoCaso).replace(/[^\p{L}\p{N}_-]+/gu, '-');
      baixar(b, `${base}-coroa-${fdi}.stl`, 'model/stl');
    });

  const podeAvancar = useMemo(() => {
    if (etapa === 0) return Boolean(nomeArco && fdi);
    if (etapa === 1) return Boolean(dente);
    if (etapa === 2) return Boolean(plano);
    if (etapa === 3) return Boolean(coroa);
    return false;
  }, [etapa, nomeArco, fdi, dente, coroa, plano]);

  const escolherDente = (n: number) => {
    if (n === fdi) return;
    setFdi(n);
    descartarDente();
    visor.current?.enquadrar('arco', undefined, undefined, frenteDoArco);
  };

  const mudarMaterial = (id: string) => {
    setMaterialId(id);
    const m = MATERIAIS.find((x) => x.id === id);
    // A broca é da fresadora, não do material.
    if (m) setParametros((p) => ({ ...m.parametros, diametroBroca: p.diametroBroca }));
    descartarCoroa();
  };

  const comecarCasoNovo = () =>
    executar(T.limpandoCaso, async () => {
      await (motor.current as ClienteDoMotor).pedir<null>({ tipo: 'novo' });
      const v = visor.current as Visor3D;
      descartarDente();
      v.definirMalha('arco', null);
      v.definirMalha('ant', null);
      setNomeArco(null);
      setNomeAnt(null);
      setFrenteDoArco(undefined);
      setFdi(null);
      setMapa('nenhum');
      setVerArco(true);
      setVerAnt(false);
      // Ajustes do caso anterior não passam para o novo; o material e a broca, sim.
      setParametros((p) => ({ ...(MATERIAIS.find((m) => m.id === materialId) ?? MATERIAIS[0]).parametros, diametroBroca: p.diametroBroca }));
      setFicha((f) => fichaNova(f.tecnico));
    });

  const avancar = () => {
    if (etapa === 0) setRecentes(guardarRecentes(ficha));
    if (etapa === 2) {
      void gerarCoroa();
      return;
    }
    setEtapa(etapa + 1);
  };

  const r = coroa?.relatorio;
  const resumoDoCaso: [string, string][] = (
    [
      [T.fichaNumero, ficha.numero],
      [T.fichaCliente, ficha.cliente],
      [T.fichaPaciente, ficha.nomeDoCaso],
      [T.fichaTecnico, ficha.tecnico],
      [T.fichaDenteSel, fdi ? String(fdi) : ''],
      [T.material, MATERIAIS.find((m) => m.id === materialId)?.nome ?? ''],
      [T.fichaCor, ficha.cor],
      [T.pBroca, nr(parametros.diametroBroca)],
      [T.fichaNotas, ficha.notas],
    ] as [string, string][]
  ).filter(([, valor]) => valor.trim());
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-border bg-background text-sm';

  return (
    <div className="relative h-full flex flex-col md:flex-row min-h-0" data-testid="passos-cad">
      {etapa === 0 && (
        <FichaDoCaso
          ficha={ficha}
          aoMudarFicha={setFicha}
          recentes={recentes}
          fdi={fdi}
          temCoroa={temCoroa}
          aoEscolherDente={escolherDente}
          materialId={materialId}
          aoMudarMaterial={mudarMaterial}
          diametroBroca={parametros.diametroBroca}
          aoMudarBroca={(v) => setParametros((p) => ({ ...p, diametroBroca: v }))}
          nomeArco={nomeArco}
          nomeAnt={nomeAnt}
          aoAbrirArquivo={(qual, f) => void abrirArquivo(qual, f)}
          aoDesenhar={avancar}
          aoComecarNovo={() => void comecarCasoNovo()}
          ocupado={ocupado}
          erro={erro}
        />
      )}
      {etapa > 0 && (
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
                    disabled={Boolean(ocupado)}
                    className="w-full px-2 py-2 rounded-lg border border-border text-xs disabled:opacity-40"
                    onClick={() => {
                      descartarDente();
                      (visor.current as Visor3D).enquadrar('arco', undefined, undefined, frenteDoArco);
                    }}
                  >
                    {T.clicarDeNovo}
                  </button>
                </>
              )}
            </>
          )}

          {etapa === 2 && (
            <div className="space-y-3" data-testid="painel-ia">
              <p className="text-xs text-muted-foreground">{T.iaExplica}</p>
              <p className="text-[11px] text-muted-foreground">{T.iaPrivacidade}</p>
              <button type="button" data-testid="desenhar-ia" disabled={Boolean(ocupado)} onClick={() => void desenharPeloPlano(true)} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40">
                <Sparkles size={16} /> {T.iaDesenhar}
              </button>
              <button type="button" data-testid="desenhar-sem-ia" disabled={Boolean(ocupado)} onClick={() => void desenharPeloPlano(false)} className="w-full px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-40">
                {T.iaSemIa}
              </button>
            </div>
          )}

          {etapa === 2 && tracos > 0 && <p className="text-xs text-amber-600" data-testid="aviso-gerar-apaga">{T.gerarApaga}</p>}

          {etapa === 3 && coroa && r && (
            <>
              {plano && <p className="text-[11px] text-muted-foreground" data-testid="origem-do-desenho">{plano.origem === 'ia' ? T.iaOrigemIa : T.iaOrigemBase}</p>}
              <Campo rotulo={T.mapa}>
                <select className={inputCls} data-testid="mapa" value={mapa} onChange={(e) => setMapa(e.target.value as MapaId)}>
                  {MAPAS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.nome}
                    </option>
                  ))}
                </select>
              </Campo>
              {mapa === 'broca' && (
                <button type="button" data-testid="ver-por-dentro" onClick={verPorDentro} className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-border text-xs hover:bg-muted">
                  <Focus size={14} /> {T.verPorDentro}
                </button>
              )}
              <div className="flex gap-3 text-xs">
                <label className="inline-flex items-center gap-1"><input type="checkbox" checked={verArco} onChange={(e) => setVerArco(e.target.checked)} /> {T.verArco}</label>
                {nomeAnt && <label className="inline-flex items-center gap-1"><input type="checkbox" checked={verAnt} onChange={(e) => setVerAnt(e.target.checked)} /> {T.verAntagonista}</label>}
              </div>
              <div className="space-y-2 pt-2 border-t border-border" data-testid="esculpir">
                <p className="text-xs font-semibold text-foreground">{T.esculpir}</p>
                <div className="grid grid-cols-3 gap-1">
                  {PINCEIS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      data-testid={`pincel-${p.id}`}
                      aria-pressed={pincel === p.id}
                      disabled={Boolean(ocupado)}
                      onClick={() => setPincel(pincel === p.id ? null : p.id)}
                      className={`px-2 py-1.5 rounded-lg border text-xs font-semibold disabled:opacity-40 ${pincel === p.id ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
                    >
                      {p.nome}
                    </button>
                  ))}
                </div>
                {pincel && (
                  <>
                    <label className="block">
                      <span className="flex justify-between text-xs">
                        <span className="font-semibold">{T.pincelTamanho}</span>
                        <span className="text-muted-foreground">{tamanhoPincel.toFixed(1)} mm</span>
                      </span>
                      <input type="range" data-testid="pincel-tamanho" className="w-full" min={0.5} max={4} step={0.1} value={tamanhoPincel} onChange={(e) => setTamanhoPincel(+e.target.value)} />
                    </label>
                    <label className="block">
                      <span className="flex justify-between text-xs">
                        <span className="font-semibold">{T.pincelForca}</span>
                        <span className="text-muted-foreground">{Math.round(forcaPincel * 100)}%</span>
                      </span>
                      <input type="range" data-testid="pincel-forca" className="w-full" min={0.05} max={1} step={0.05} value={forcaPincel} onChange={(e) => setForcaPincel(+e.target.value)} />
                    </label>
                    <p className="text-[11px] text-muted-foreground">{T.pincelAjuda}</p>
                  </>
                )}
                <button type="button" data-testid="desfazer-traco" disabled={!tracos || Boolean(ocupado)} onClick={() => void desfazerTraco()} className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-border text-xs disabled:opacity-40">
                  <RotateCcw size={14} /> {T.desfazerTraco}
                </button>
                {medindo && <p className="text-[11px] text-muted-foreground" data-testid="medindo">{T.medindo}</p>}
                {noLimite && <p className="text-xs text-amber-600" data-testid="aviso-limite">{T.pincelNoLimite}</p>}
                {entrou.vizinho && <p className="text-xs text-amber-600" data-testid="aviso-entrou-vizinho">{T.avisoEntrouVizinho}</p>}
                {entrou.antagonista && <p className="text-xs text-amber-600" data-testid="aviso-entrou-antagonista">{T.avisoEntrouAntagonista}</p>}
              </div>
              <div className="space-y-2 pt-2 border-t border-border">
                {([
                  ['cimento', T.pCimento],
                  ['inicioCimento', T.pInicioCimento],
                  ['espessuraOclusal', T.pEspessuraOclusal],
                  ['espessuraMinima', T.pEspessura],
                  ['folgaAntagonista', T.pAntagonista],
                  ['folgaVizinho', T.pVizinho],
                ] as const).map(([chave, rotulo]) => (
                  <label key={chave} className="flex items-center justify-between gap-2 text-xs">
                    <span>{rotulo}</span>
                    {/* Só a folga do vizinho aceita negativo: é a leve sobreposição que a fresagem consome. */}
                    <input type="number" step={0.01} min={chave === 'folgaVizinho' ? -0.1 : 0} className="w-20 px-2 py-1 rounded border border-border bg-background text-right" value={parametros[chave]} onChange={(e) => setParametros({ ...parametros, [chave]: +e.target.value })} />
                  </label>
                ))}
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span>{T.pBroca}</span>
                  <CampoDeBroca
                    className="w-20 px-2 py-1 rounded border border-border bg-background text-right"
                    valor={parametros.diametroBroca}
                    aoMudar={(v) => setParametros((p) => ({ ...p, diametroBroca: v }))}
                  />
                </label>
                <button type="button" disabled={Boolean(ocupado)} onClick={() => void gerarCoroa()} className="w-full inline-flex items-center justify-center gap-1 px-2 py-2 rounded-lg border border-border text-xs disabled:opacity-40">
                  <RotateCcw size={14} /> {T.recalcular}
                </button>
                {tracos > 0 && <p className="text-[11px] text-amber-600">{T.recalcularApaga}</p>}
              </div>
              <dl className="text-xs grid grid-cols-2 gap-x-3 gap-y-1 pt-2 border-t border-border" data-testid="relatorio">
                <dt className="text-muted-foreground">{T.rTamanho}</dt>
                <dd className="text-right">{`${nr(r.mdMm)} × ${nr(r.vlMm)} × ${nr(r.alturaMm)} mm`}</dd>
                <dt className="text-muted-foreground">{T.rEspOclusal}</dt>
                <dd className="text-right">{r.espessuraOclusal ? `${nr(r.espessuraOclusal.p5)} / ${nr(r.espessuraOclusal.mediana)} mm` : '—'}</dd>
                <dt className="text-muted-foreground">{T.rContatoAnt}</dt>
                <dd className="text-right">{nomeAnt ? r.regioesContatoAntagonista : '—'}</dd>
                <dt className="text-muted-foreground">{T.rContatoViz}</dt>
                <dd className="text-right">{r.regioesContatoVizinho}</dd>
                <dt className="text-muted-foreground">{T.rMalha}</dt>
                <dd className="text-right">{r.malha.arestasAbertas === 0 && r.malha.arestasRepetidas === 0 ? T.rMalhaOk : T.rMalhaRuim}</dd>
                <dt className="text-muted-foreground">{T.rFresa}</dt>
                <dd className="text-right" data-testid="corte-broca">
                  {r.fresa.diametro <= 0 ? T.rFresaDesligada : r.fresa.maiorCorte > 0 ? `${T.rFresaAte} ${nr(r.fresa.maiorCorte)} mm` : T.rFresaNada}
                </dd>
              </dl>
              {r.fresa.maiorCorte > CORTE_GRANDE_DA_BROCA && <p className="text-xs text-amber-600" data-testid="aviso-broca">{T.avisoBrocaGrande}</p>}
              {nomeAnt && r.espessuraOclusal && r.espessuraOclusal.p5 > parametros.espessuraOclusal + 1 && <p className="text-xs text-amber-600" data-testid="aviso-alta">{T.avisoAlta}</p>}
              {r.conflitosEspessura > 0 && <p className="text-xs text-amber-600">{T.avisoConflito}</p>}
              {r.retencoesPreenchidas > 0 && <p className="text-xs text-amber-600">{T.avisoRetencao}</p>}
            </>
          )}

          {etapa === 4 && coroa && (
            <>
              <p className="text-sm">{T.exportarTexto}</p>
              <button type="button" data-testid="baixar-stl" disabled={Boolean(ocupado)} onClick={() => void exportar()} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40">
                <Download size={16} /> {T.baixarStl}
              </button>
              <p className="text-xs text-amber-600">{T.avisoRevisao}</p>
              <div className="pt-2 border-t border-border" data-testid="resumo-do-caso">
                <p className="text-xs font-semibold text-foreground mb-1">{T.resumoCaso}</p>
                <dl className="text-xs grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  {resumoDoCaso.map(([rotulo, valor]) => (
                    <Fragment key={rotulo}>
                      <dt className="text-muted-foreground">{rotulo}</dt>
                      <dd className="text-right break-words">{valor}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
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
      )}

      <div className="relative flex-1 min-h-[360px]">
        <div ref={caixa} className="absolute inset-0" data-testid="visor" />
        {nomeArco && (
          <button type="button" data-testid="centralizar" onClick={centralizarVista} className="absolute top-3 right-3 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-black/60 text-white text-xs hover:bg-black/75">
            <Focus size={14} /> {T.centralizarVista}
          </button>
        )}
        {ocupado && etapa > 0 && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/70 text-white text-xs inline-flex items-center gap-2" data-testid="ocupado">
            <Loader2 size={14} className="animate-spin" /> {ocupado}
          </div>
        )}
      </div>
    </div>
  );
}
