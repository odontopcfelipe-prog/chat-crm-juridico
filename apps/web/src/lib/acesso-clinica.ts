'use client';

/**
 * Dono do sistema (SUPER_ADMIN) dentro de outra conta sem ter usuário nela.
 * A API (POST /auth/acessar-clinica) devolve um login novo com a conta escolhida
 * e a marca `acesso_clinica` { modo, nome } — ver apps/api/src/auth/acesso-clinica.ts.
 */
import api, { clearSessionTraces } from '@/lib/api';

export type ModoDeAcesso = 'ver' | 'mexer';

export interface AcessoClinica {
  modo: ModoDeAcesso;
  nome: string;
}

/** Código do 403 da API no modo só ver. */
export const CODIGO_SO_VER = 'SO_VER';

/** Payload do token (UTF-8: o nome da conta tem acento), ou null se ilegível. */
function payloadDoToken(token: string | null): any {
  if (!token) return null;
  try {
    let b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Marca do token, ou null no login normal. */
export function lerAcessoDoToken(token: string | null): AcessoClinica | null {
  const a = payloadDoToken(token)?.acesso_clinica;
  if (a && (a.modo === 'ver' || a.modo === 'mexer')) return { modo: a.modo, nome: String(a.nome ?? '') };
  return null;
}

/** Conta em que a sessão está agora (a visitada, ou a própria). */
export function contaDoToken(token: string | null): string | null {
  const t = payloadDoToken(token)?.tenant_id;
  return typeof t === 'string' && t ? t : null;
}

/**
 * Entra na conta (`tenantId` + modo) ou volta para a própria (`tenantId` null).
 * Troca o token e recarrega a página inteira: papel, conta, permissões e a faixa
 * saem do token novo.
 */
export async function trocarDeConta(tenantId: string | null, modo?: ModoDeAcesso): Promise<void> {
  // Volta por rota própria: é a que passa também de dentro de um laboratório.
  const { data } = tenantId
    ? await api.post('/auth/acessar-clinica', { tenant_id: tenantId, modo })
    : await api.post('/auth/voltar-conta');
  if (!data?.access_token) throw new Error('Login novo não veio.');
  // Rascunhos e filtros guardados no navegador são da conta de antes.
  clearSessionTraces();
  localStorage.setItem('token', data.access_token);
  window.location.href = '/atendimento/dashboard';
}

/** Conta + modo da sessão, para saber se outra aba trocou de conta. */
function contaEModo(token: string | null) {
  return { conta: contaDoToken(token), modo: lerAcessoDoToken(token)?.modo ?? null };
}

/**
 * O token fica no localStorage, que é de todas as abas: entrar numa conta numa aba
 * faria a outra aba (ainda mostrando a conta de antes) gravar na conta nova.
 * Quando outra aba troca de conta (entra, volta ou passa para outra), esta recarrega.
 * Fora disso (sair, login de novo na mesma conta) nada muda.
 */
export function precisaRecarregar(antes: string | null, agora: string | null): boolean {
  const a = contaEModo(antes);
  const d = contaEModo(agora);
  if (a.conta === d.conta && a.modo === d.modo) return false;
  return !!a.modo || !!d.modo || (!!a.conta && !!d.conta);
}
