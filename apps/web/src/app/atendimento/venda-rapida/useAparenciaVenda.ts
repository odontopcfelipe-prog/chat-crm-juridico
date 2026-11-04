'use client';

/**
 * Aparência da Nova venda. O navegador guarda a última por conta só para a tela não abrir
 * amarela e trocar de cor em seguida: quem manda é o servidor, e sem nada vale o padrão.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import { decodeJwtPayload } from '@crm/shared';
import api from '@/lib/api';
import { APARENCIA_PADRAO, normalizarAparencia, type Aparencia } from './aparencia';

const chaveLocal = () => {
  const sessao = decodeJwtPayload(window.localStorage.getItem('token') ?? '');
  return `venda-rapida-aparencia:${sessao?.tenant_id ?? ''}`;
};

export function guardarAparenciaLocal(aparencia: Aparencia) {
  try {
    window.localStorage.setItem(chaveLocal(), JSON.stringify(aparencia));
  } catch { /* navegador sem armazenamento: só perde o atalho */ }
}

export function useAparenciaVenda(): Aparencia {
  const [aparencia, setAparencia] = useState<Aparencia>(APARENCIA_PADRAO);

  useLayoutEffect(() => {
    try {
      const guardada = window.localStorage.getItem(chaveLocal());
      if (guardada) setAparencia(normalizarAparencia(JSON.parse(guardada)));
    } catch { /* idem */ }
  }, []);

  useEffect(() => {
    api.get('/procedures/aparencia-venda')
      .then(({ data }) => {
        const atual = normalizarAparencia(data);
        setAparencia(atual);
        guardarAparenciaLocal(atual);
      })
      .catch(() => { /* só muda a cor: a venda segue com a última conhecida */ });
  }, []);

  return aparencia;
}
