/// <reference lib="webworker" />
/**
 * Passos CAD — Web Worker: o cálculo pesado roda aqui para a tela não travar. Os arquivos do
 * caso ficam neste computador: o worker não acessa a rede.
 */
import type { Malha, V3 } from './geo';
import type { Ajuste, Parametros } from './coroa';
import type { MedidasDaCoroa, MudancaDaMalha, OpcoesPincel } from './escultura';
import type { PlanoDoDente } from './plano-do-dente';
import { Sessao, type ResumoCoroa } from './sessao';

export type Pedido =
  | { tipo: 'arco'; nome: string; buf: ArrayBuffer }
  | { tipo: 'antagonista'; nome: string; buf: ArrayBuffer }
  | { tipo: 'mordida' }
  | { tipo: 'apontar'; o: V3; d: V3 }
  | { tipo: 'dente'; fdi: number; clique: V3; normal: V3 }
  | { tipo: 'margem'; fixos: V3[] }
  | { tipo: 'anatomia'; nome: string; buf: ArrayBuffer; parametros: Parametros }
  | { tipo: 'reposicionar'; parametros: Parametros }
  | { tipo: 'mover'; ajuste: Ajuste; parametros: Parametros }
  | { tipo: 'coroa'; ajuste: Ajuste; parametros: Parametros }
  | { tipo: 'quadroIa'; parametros: Parametros }
  | { tipo: 'coroaDoPlano'; plano: PlanoDoDente; parametros: Parametros }
  | { tipo: 'novo' }
  | { tipo: 'mira'; o: V3; d: V3 }
  | { tipo: 'pincel'; raios: [V3, V3][]; opcoes: OpcoesPincel; inicio: boolean }
  | { tipo: 'pincelFim' }
  | { tipo: 'pincelDesfazer' }
  | { tipo: 'pincelMedir' }
  | { tipo: 'stl' };

export interface MalhaLeve {
  pos: Float32Array;
  tri: Uint32Array;
}

const escopo = self as unknown as DedicatedWorkerGlobalScope;
const sessao = new Sessao();

const buffersDaMudanca = (m: MudancaDaMalha | null): Transferable[] => (m ? [m.idx.buffer, m.pos.buffer, m.nor.buffer] : []);
const buffersDasMedidas = (r: MedidasDaCoroa | null): Transferable[] => (r ? [r.espessura.buffer, r.folgaAntagonista.buffer, r.folgaVizinho.buffer] : []);

/** Cópia em float32 para a tela: a original fica no worker. */
function leve(m: Malha): MalhaLeve {
  return { pos: Float32Array.from(m.pos), tri: Uint32Array.from(m.tri) };
}

/** A coroa pronta, nos dois jeitos de modelar. */
function coroaNaResposta(c: ResumoCoroa): { dados: unknown; envio: Transferable[] } {
  const m = leve(c.malha);
  const e = Float32Array.from(c.espessura);
  const pedida = Float32Array.from(c.espessuraPedida);
  const a = Float32Array.from(c.folgaAntagonista);
  const v = Float32Array.from(c.folgaVizinho);
  const f = Float32Array.from(c.corteFresa);
  return {
    dados: { malha: m, espessura: e, espessuraPedida: pedida, folgaAntagonista: a, folgaVizinho: v, corteFresa: f, externos: c.externos, relatorio: c.relatorio },
    envio: [m.pos.buffer, m.tri.buffer, e.buffer, pedida.buffer, a.buffer, v.buffer, f.buffer],
  };
}

function atender(p: Pedido): { dados: unknown; envio: Transferable[] } {
  switch (p.tipo) {
    case 'arco': {
      const m = leve(sessao.abrirArco(p.nome, p.buf));
      return { dados: m, envio: [m.pos.buffer, m.tri.buffer] };
    }
    case 'antagonista': {
      const m = leve(sessao.abrirAntagonista(p.nome, p.buf));
      return { dados: m, envio: [m.pos.buffer, m.tri.buffer] };
    }
    case 'mordida':
      return { dados: sessao.conferirMordida(), envio: [] };
    case 'apontar':
      return { dados: sessao.apontar(p.o, p.d), envio: [] };
    case 'dente':
      return { dados: sessao.abrirDente(p.fdi, p.clique, p.normal), envio: [] };
    case 'margem':
      return { dados: sessao.proporMargem(p.fixos), envio: [] };
    case 'anatomia': {
      const r = sessao.abrirAnatomia(p.nome, p.buf, p.parametros);
      const m = leve(r.malha);
      return { dados: { ajuste: r.ajuste, malha: m }, envio: [m.pos.buffer, m.tri.buffer] };
    }
    case 'reposicionar': {
      const r = sessao.reposicionar(p.parametros);
      const m = leve(r.malha);
      return { dados: { ajuste: r.ajuste, malha: m }, envio: [m.pos.buffer, m.tri.buffer] };
    }
    case 'mover': {
      const m = leve(sessao.moverAnatomia(p.ajuste, p.parametros));
      return { dados: m, envio: [m.pos.buffer, m.tri.buffer] };
    }
    case 'coroa':
      return coroaNaResposta(sessao.construir(p.ajuste, p.parametros));
    case 'quadroIa':
      return { dados: sessao.quadroParaIa(p.parametros), envio: [] };
    case 'coroaDoPlano':
      return coroaNaResposta(sessao.construirComPlano(p.plano, p.parametros));
    case 'novo':
      sessao.fecharCaso();
      return { dados: null, envio: [] };
    case 'mira':
      return { dados: sessao.mirarPincel(p.o, p.d), envio: [] };
    case 'pincel': {
      const r = sessao.pincelar(p.raios, p.opcoes, p.inicio);
      return { dados: r, envio: buffersDaMudanca(r.mudanca) };
    }
    case 'pincelFim':
      return { dados: sessao.terminarTraco(), envio: [] };
    case 'pincelDesfazer': {
      const r = sessao.desfazerTraco();
      return { dados: r, envio: buffersDaMudanca(r?.mudanca ?? null) };
    }
    case 'pincelMedir': {
      const r = sessao.medirCoroa();
      return { dados: r, envio: buffersDasMedidas(r) };
    }
    case 'stl': {
      const b = sessao.exportarStl();
      return { dados: b, envio: [b] };
    }
  }
}

function mensagemDoErro(erro: unknown): string {
  if (erro instanceof RangeError) return 'O cálculo passou do limite deste computador. Feche outras abas e tente de novo.';
  return erro instanceof Error ? erro.message : 'Erro no cálculo.';
}

escopo.onmessage = (ev: MessageEvent<{ id: number; pedido: Pedido }>) => {
  const { id, pedido } = ev.data;
  try {
    const { dados, envio } = atender(pedido);
    escopo.postMessage({ id, ok: true, dados }, envio);
  } catch (erro) {
    escopo.postMessage({ id, ok: false, erro: mensagemDoErro(erro) });
  }
};
