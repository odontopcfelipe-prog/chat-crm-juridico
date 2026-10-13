// O schedule-x v4 usa `Temporal` global. Chrome recente tem nativo; Safari/iPhone
// e Chromes antigos não → a agenda quebrava com "Algo deu errado" no celular.
// Instala o polyfill SÓ quando falta (o entry `temporal-polyfill/global` também
// sobrescreveria Intl.DateTimeFormat do navegador inteiro).
import { Temporal } from 'temporal-polyfill';

if (typeof (globalThis as any).Temporal === 'undefined') {
  Object.defineProperty(globalThis, 'Temporal', {
    value: Temporal,
    writable: true,
    configurable: true,
  });
}

export {};
