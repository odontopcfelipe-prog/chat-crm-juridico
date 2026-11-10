/**
 * Baixa um arquivo do chat (documento, imagem, STL...) pelo gerenciador de downloads do
 * navegador, NA HORA do clique.
 *
 * Por que não fetch + "Salvar como" (como era até nov/2026): o navegador só abre a janela
 * de salvar logo depois do clique (uns 5 s). Arquivo grande (STL de escaneamento, vídeo)
 * demora mais que isso para chegar pelo túnel do servidor, a janela era recusada e o erro
 * ficava só no console: para quem clicava, "não baixa". Pelo link, o próprio navegador
 * baixa, mostra o progresso e não segura o arquivo inteiro na memória da aba.
 *
 * `/api/media/<id>` é pública e com `?dl=1` responde como anexo, com o nome original.
 * Endereço de outro site (foto de perfil do WhatsApp, por exemplo) abre numa aba nova:
 * lá o navegador ignora o "baixar" e a aba do chat não pode sair da conversa.
 */
export function urlDeDownload(url: string): string {
  if (!url.startsWith('/api/media/')) return url;
  const [base, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('dl', '1');
  return `${base}?${params.toString()}`;
}

function mesmaOrigem(href: string): boolean {
  if (href.startsWith('blob:') || href.startsWith('data:')) return true;
  try {
    return new URL(href, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** `nome` vazio deixa o nome que o servidor manda (o original do arquivo). */
export function baixarArquivo(url: string, nome?: string | null): void {
  const href = urlDeDownload(url);
  const a = document.createElement('a');
  a.href = href;
  if (mesmaOrigem(href)) {
    a.download = nome || '';
  } else {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
