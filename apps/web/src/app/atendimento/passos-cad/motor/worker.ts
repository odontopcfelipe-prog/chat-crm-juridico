/// <reference lib="webworker" />
/**
 * Passos CAD — Web Worker: o cálculo pesado roda aqui para a tela não travar. Os arquivos do
 * caso ficam neste computador: o worker não acessa a rede.
 */
import type { Malha, V3 } from './geo';
import type { Ajuste, Parametros } from './coroa';
import { Sessao } from './sessao';

export type Pedido =
  | { tipo: 'arco'; nome: string; buf: ArrayBuffer }
  | { tipo: 'antagonista'; nome: string; buf: ArrayBuffer }
  | { tipo: 'apontar'; o: V3; d: V3 }
  | { tipo: 'dente'; fdi: number; clique: V3; normal: V3 }
  | { tipo: 'margem'; fixos: V3[] }
  | { tipo: 'anatomia'; nome: string; buf: ArrayBuffer; parametros: Parametros }
  | { tipo: 'reposicionar'; parametros: Parametros }
  | { tipo: 'mover'; ajuste: Ajuste; parametros: Parametros }
  | { tipo: 'coroa'; ajuste: Ajuste; parametros: Parametros }
  | { tipo: 'stl' };

export interface MalhaLeve {
  pos: Float32Array;
  tri: Uint32Array;
}

const escopo = self as unknown as DedicatedWorkerGlobalScope;
const sessao = new Sessao();

/** Cópia em float32 para a tela: a original fica no worker. */
function leve(m: Malha): MalhaLeve {
  return { pos: Float32Array.from(m.pos), tri: Uint32Array.from(m.tri) };
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
    case 'coroa': {
      const c = sessao.construir(p.ajuste, p.parametros);
      const m = leve(c.malha);
      const e = Float32Array.from(c.espessura);
      const a = Float32Array.from(c.folgaAntagonista);
      const v = Float32Array.from(c.folgaVizinho);
      return {
        dados: { malha: m, espessura: e, folgaAntagonista: a, folgaVizinho: v, externos: c.externos, relatorio: c.relatorio },
        envio: [m.pos.buffer, m.tri.buffer, e.buffer, a.buffer, v.buffer],
      };
    }
    case 'stl': {
      const b = sessao.exportarStl();
      return { dados: b, envio: [b] };
    }
  }
}

escopo.onmessage = (ev: MessageEvent<{ id: number; pedido: Pedido }>) => {
  const { id, pedido } = ev.data;
  try {
    const { dados, envio } = atender(pedido);
    escopo.postMessage({ id, ok: true, dados }, envio);
  } catch (erro) {
    escopo.postMessage({ id, ok: false, erro: erro instanceof Error ? erro.message : 'Erro no cálculo.' });
  }
};
