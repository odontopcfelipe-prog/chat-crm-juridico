/**
 * F4 do laboratório — anti-piscada no Ctrl+F5.
 *
 * O React só sabe o tipo de negócio depois de hidratar (o servidor não vê o
 * token, que mora no localStorage). Sem isto, uma sessão de laboratório via a
 * casca da clínica por um instante a cada recarga.
 *
 * Este script roda no <head>, antes do body pintar: em /atendimento (fora do
 * login), se o token salvo traz o claim bt de laboratório, marca o <html> com
 * data-bt. O globals.css esconde o body enquanto não houver data-bt-pronto,
 * que o hook useBusinessType põe quando a tela do laboratório monta. Se o JS da
 * página quebrar, um temporizador de 4 s põe data-bt-pronto mesmo assim.
 *
 * Token de clínica (sem o claim) ou ilegível: o script não toca em nada.
 * Componente de servidor (sem 'use client').
 */
const CODIGO = [
  '(function(){try{',
  'var p=location.pathname;',
  "if(p.indexOf('/atendimento')!==0||p.indexOf('/atendimento/login')===0)return;",
  "var t=localStorage.getItem('token');if(!t)return;",
  "var s=t.split('.')[1];if(!s)return;",
  "s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';",
  'var j=JSON.parse(atob(s));',
  "if(j&&j.bt==='LABORATORIO'){",
  'var h=document.documentElement;',
  "h.setAttribute('data-bt','LABORATORIO');",
  "setTimeout(function(){if(h.getAttribute('data-bt')==='LABORATORIO')h.setAttribute('data-bt-pronto','');},4000);",
  '}',
  '}catch(e){}})();',
].join('');

export function BtBootScript() {
  return <script id="bt-boot" dangerouslySetInnerHTML={{ __html: CODIGO }} />;
}
