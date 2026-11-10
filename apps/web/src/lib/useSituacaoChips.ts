'use client';

/**
 * Situação dos chips de WhatsApp da conta (GET /whatsapp/situacao-chips) e da internet
 * deste computador, para o aviso no topo de toda página e na barra de envio do chat.
 *
 * Uma consulta só por aba, dividida entre quem usa o hook: a cada 60 s, ao voltar para a
 * aba (no máx. 1 a cada 15 s) e quando a internet volta. Nunca duas ao mesmo tempo.
 * Sem resposta do servidor do WhatsApp ('desconhecido') o chip fica como estava: um
 * aviso vermelho não some por uma falha de consulta. 401/403 ou ninguém mais na tela
 * (saiu da conta) limpa tudo: a próxima conta não vê os chips desta.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { SituacaoDoChip } from '@crm/shared';
import api from '@/lib/api';

export interface SituacaoDaConexao {
  chips: SituacaoDoChip[];
  /** Internet deste computador (evento online/offline do navegador). */
  online: boolean;
}

const INTERVALO_MS = 60_000;
const INTERVALO_MIN_FOCO_MS = 15_000;
const VAZIO: SituacaoDaConexao = { chips: [], online: true };

let atual: SituacaoDaConexao = VAZIO;
const ouvintes = new Set<() => void>();
let assinantes = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let emVoo: Promise<void> | null = null;
let ultimaConsulta = 0;

function publicar(parte: Partial<SituacaoDaConexao>) {
  atual = { ...atual, ...parte };
  ouvintes.forEach((f) => f());
}

/** Chip que voltou 'desconhecido' mantém a situação que tinha. */
function juntar(antes: SituacaoDoChip[], novos: SituacaoDoChip[]): SituacaoDoChip[] {
  const anterior = new Map(antes.map((c) => [c.instanceName, c]));
  return novos.map((c) => (c.situacao === 'desconhecido' ? anterior.get(c.instanceName) ?? c : c));
}

function consultar(): Promise<void> {
  if (emVoo) return emVoo;
  ultimaConsulta = Date.now();
  emVoo = (async () => {
    try {
      const res = await api.get<SituacaoDoChip[]>('/whatsapp/situacao-chips', {
        timeout: 12000,
        ...({ _silent401: true } as any),
      });
      if (assinantes === 0) return; // saiu da tela enquanto esperava
      publicar({ chips: juntar(atual.chips, Array.isArray(res.data) ? res.data : []) });
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 401 || status === 403) publicar({ chips: [] });
      /* outra falha: a tela fica como estava */
    } finally {
      emVoo = null;
    }
  })();
  return emVoo;
}

const aoVoltarParaAba = () => {
  if (Date.now() - ultimaConsulta >= INTERVALO_MIN_FOCO_MS) void consultar();
};
const aoFicarOnline = () => {
  publicar({ online: true });
  void consultar();
};
const aoFicarOffline = () => publicar({ online: false });

function ligar() {
  assinantes++;
  if (assinantes > 1) return;
  publicar({ online: typeof navigator === 'undefined' || navigator.onLine !== false });
  void consultar();
  timer = setInterval(() => void consultar(), INTERVALO_MS);
  window.addEventListener('focus', aoVoltarParaAba);
  window.addEventListener('online', aoFicarOnline);
  window.addEventListener('offline', aoFicarOffline);
}

function desligar() {
  assinantes = Math.max(0, assinantes - 1);
  if (assinantes > 0) return;
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener('focus', aoVoltarParaAba);
  window.removeEventListener('online', aoFicarOnline);
  window.removeEventListener('offline', aoFicarOffline);
  atual = VAZIO; // ninguém mais na tela (ex.: saiu da conta): não guarda os chips desta conta
}

function assinar(f: () => void) {
  ouvintes.add(f);
  return () => {
    ouvintes.delete(f);
  };
}

const ler = () => atual;

export function useSituacaoChips(): SituacaoDaConexao {
  useEffect(() => {
    ligar();
    return desligar;
  }, []);
  return useSyncExternalStore(assinar, ler, ler);
}
