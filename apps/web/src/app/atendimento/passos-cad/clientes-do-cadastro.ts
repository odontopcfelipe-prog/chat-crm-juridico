/**
 * Passos CAD — a única exceção à regra de não usar a rede nesta pasta. Só lê os nomes dos dentistas
 * do cadastro da conta. Não recebe nenhum dado do caso, então não tem como levar escaneamento nem
 * ficha para fora. O teste "a única exceção de rede" em passos-cad-motor.spec.ts confere isso.
 */
import api from '@/lib/api';
// Em segundo plano: sem permissão ou com o login vencendo, o técnico não perde o caso nem leva aviso.
const EM_SEGUNDO_PLANO = { _silent401: true } as object;

export async function buscarClientesDoCadastro(sinal: AbortSignal): Promise<unknown> {
  const resposta = await api.get<unknown>('/patients/nomes', { signal: sinal, ...EM_SEGUNDO_PLANO });
  return resposta.data;
}
