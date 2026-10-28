'use client';

/**
 * F4 do laboratório — tipo de negócio da sessão no front: CLÍNICA ou LABORATÓRIO.
 *
 * O ponto de partida é o claim `bt` do token (só o token de laboratório leva o
 * claim). Na sessão de CLÍNICA o hook não faz nada além de ler o token: nenhuma
 * requisição, nenhum estado guardado e nenhum toque no DOM.
 *
 * Na sessão de LABORATÓRIO:
 *   - marca o <html> com data-bt (o CSS esconde o body até data-bt-pronto, para a
 *     casca da clínica não piscar no Ctrl+F5 — ver BtBootScript);
 *   - confirma o tipo UMA vez por conta no GET /tenants/me. Se a conta não vier
 *     como laboratório, a tela volta a ser de clínica. Se a chamada falhar, fica
 *     o tipo do token (o servidor também trata o bt do token como laboratório).
 *
 * Isto é só o que a tela mostra: quem autoriza é o servidor.
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  BT_CLINICA,
  BT_LABORATORIO,
  decodeJwtPayload,
  isLab,
  resolveBtFromToken,
  type BusinessType,
} from '@crm/shared';
import api from '@/lib/api';

// Estado do módulo (todas as instâncias do hook compartilham). Só o laboratório escreve nele.
const confirmado = new Map<string, BusinessType>();
const emVoo = new Set<string>();
const ouvintes = new Set<() => void>();

function lerToken(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('token');
  } catch {
    return null;
  }
}

function contaDoToken(token: string | null): string | null {
  const tid = decodeJwtPayload(token)?.tenant_id;
  return typeof tid === 'string' && tid ? tid : null;
}

function avisarOuvintes(): void {
  for (const ouvinte of Array.from(ouvintes)) ouvinte();
}

function assinar(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  // Login/logout em outra aba muda o token desta também.
  const aoMudarStorage = () => ouvinte();
  window.addEventListener('storage', aoMudarStorage);
  return () => {
    ouvintes.delete(ouvinte);
    window.removeEventListener('storage', aoMudarStorage);
  };
}

/** No servidor (e na 1ª renderização da hidratação) é sempre clínica. */
function btDoServidor(): BusinessType {
  return BT_CLINICA;
}

/**
 * Tipo de negócio AGORA, sem esperar render. Token sem o claim de laboratório =
 * clínica na hora, sem rede e sem estado. Token de laboratório = o que o
 * /tenants/me confirmou para a conta, ou o próprio token enquanto não confirmou.
 */
export function btAgora(): BusinessType {
  const token = lerToken();
  if (!isLab(resolveBtFromToken(token))) return BT_CLINICA;
  const tid = contaDoToken(token);
  return (tid !== null ? confirmado.get(tid) : undefined) ?? BT_LABORATORIO;
}

/**
 * Tipo de negócio da sessão. `tokenKey` (opcional) é o token que o chamador já
 * acompanha (o layout de /atendimento persiste no login → dashboard): quando ele
 * muda, todas as instâncias do hook releem o token. Na clínica o resultado não
 * muda e nada renderiza de novo.
 */
export function useBusinessType(tokenKey?: string | null): BusinessType {
  const bt = useSyncExternalStore(assinar, btAgora, btDoServidor);

  useEffect(() => {
    // Sem tokenKey não há o que acompanhar: cada render já lê o token agora.
    if (tokenKey === undefined) return;
    avisarOuvintes();
  }, [tokenKey]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;

    if (!isLab(bt)) {
      // A 1ª renderização da hidratação devolve CLÍNICA (btDoServidor): ela não
      // pode apagar a marca que o script de boot pôs numa sessão de laboratório.
      if (html.hasAttribute('data-bt') && !isLab(btAgora())) {
        html.removeAttribute('data-bt');
        html.removeAttribute('data-bt-pronto');
      }
      return;
    }

    html.setAttribute('data-bt', BT_LABORATORIO);
    html.setAttribute('data-bt-pronto', '');

    const tid = contaDoToken(lerToken());
    if (tid === null || confirmado.has(tid) || emVoo.has(tid)) return;
    emVoo.add(tid);
    api
      .get<{ id?: unknown; business_type?: unknown } | null>('/tenants/me')
      .then(({ data }) => {
        if (!data || data.id !== tid) return;
        // Só confirma laboratório. Sem o campo (ex.: falha ao ler o perfil) fica o tipo do token.
        if (isLab(data.business_type)) confirmado.set(tid, BT_LABORATORIO);
      })
      .catch(() => {
        // Falhou: não grava nada e fica o tipo do token.
      })
      .finally(() => {
        emVoo.delete(tid);
        avisarOuvintes();
      });
  }, [bt]);

  return bt;
}
