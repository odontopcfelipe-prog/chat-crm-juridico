/**
 * F7 do laboratório — o catálogo da Central de Disparos na conta de laboratório.
 *
 * É o catálogo da clínica (disparos.config.ts, que não muda) filtrado pela lista
 * permitida do @crm/shared, na mesma ordem, com os nomes e gatilhos do laboratório
 * (lab-disparos-textos.ts).
 *
 * A clínica nunca passa por aqui: a tela usa DISPAROS, SETORES e CATEGORIAS como hoje.
 */
import { DISPAROS_VISIVEIS_NO_LABORATORIO } from '@crm/shared';
import { CATEGORIAS, DISPAROS, SETORES, type DisparoItem } from './disparos.config';
import { LAB_CATEGORIAS, LAB_DISPAROS_CARDS, LAB_SETORES } from './lab-disparos-textos';

type SetorDaCentral = (typeof SETORES)[number];
type CategoriaDaCentral = (typeof CATEGORIAS)[number];

let catalogo: DisparoItem[] | null = null;
let setores: SetorDaCentral[] | null = null;
let categorias: CategoriaDaCentral[] | null = null;

/** Os cards do laboratório, na ordem da clínica, com os textos do laboratório. */
export function catalogoDoLaboratorio(): DisparoItem[] {
  if (catalogo) return catalogo;
  catalogo = DISPAROS.filter((d) => DISPAROS_VISIVEIS_NO_LABORATORIO.has(d.id)).map((d): DisparoItem => {
    const t = LAB_DISPAROS_CARDS[d.id];
    return {
      ...d,
      ...(t?.nome !== undefined ? { nome: t.nome } : {}),
      ...(t?.gatilho !== undefined ? { gatilho: t.gatilho } : {}),
      ...(t?.descricao !== undefined ? { descricao: t.descricao } : {}),
      ...(t?.tags !== undefined ? { tags: [...t.tags] } : {}),
    };
  });
  return catalogo;
}

/** Setores do laboratório: Atendimento (chip principal), Financeiro e Equipe. */
export function setoresDoLaboratorio(): SetorDaCentral[] {
  if (setores) return setores;
  setores = SETORES.filter((s) => s.id !== 'comercial').map((s): SetorDaCentral => ({ ...s, ...(LAB_SETORES[s.id] ?? {}) }));
  return setores;
}

/** Categorias com os rótulos do laboratório (as que não mudam ficam como estão). */
export function categoriasDoLaboratorio(): CategoriaDaCentral[] {
  if (categorias) return categorias;
  categorias = CATEGORIAS.map((c): CategoriaDaCentral => {
    const label = LAB_CATEGORIAS[c.id];
    return label !== undefined ? { ...c, label } : c;
  });
  return categorias;
}
