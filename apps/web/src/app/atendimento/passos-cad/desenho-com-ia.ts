/**
 * Passos CAD — a segunda exceção à regra de não usar a rede nesta pasta, e só acontece quando o
 * técnico clica em "Desenhar com IA". O pedido tem só o número do dente e medidas em mm: nem
 * escaneamento, nem imagem, nem ficha. O teste "as exceções de rede" em passos-cad-motor.spec.ts
 * trava esta chamada.
 */
import api from '@/lib/api';
import type { PedidoDesenhoIa } from './motor/plano-do-dente';
// Login vencendo no meio do caso não pode derrubar o que o técnico já fez: o erro aparece na tela.
const SEM_DERRUBAR_O_CASO = { _silent401: true } as object;

export async function pedirDesenhoIa(pedido: PedidoDesenhoIa): Promise<unknown> {
  const resposta = await api.post<{ plano: unknown }>('/passos-cad/desenho-ia', pedido, SEM_DERRUBAR_O_CASO);
  return resposta.data.plano;
}
