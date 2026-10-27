import SignupPage, { type Caminho } from './CadastroPage';

/**
 * /cadastrar — lê ?tipo= no servidor para a página já abrir no caminho certo
 * (/cadastrar?tipo=laboratorio abre direto na lista de espera do laboratório).
 */
export default async function CadastrarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tipo } = await searchParams;
  const caminho: Caminho = typeof tipo === 'string' && tipo.toLowerCase() === 'laboratorio' ? 'LABORATORIO' : 'CLINICA';
  return <SignupPage caminhoInicial={caminho} />;
}
