import SignupPage, { type Caminho } from './CadastroPage';

/**
 * /cadastrar — lê ?tipo= e ?convite= no servidor para a página já abrir no
 * caminho certo (/cadastrar?tipo=laboratorio abre direto no Laboratório).
 *
 * O Laboratório tem 3 estados, decididos no navegador pela API
 * (POST /signup/laboratorio/situacao): convite válido → formulário de cadastro;
 * cadastro aberto → formulário de cadastro; senão → a lista de espera de hoje.
 * Link do convite: /cadastrar?tipo=laboratorio&convite=<codigo> (só com
 * ?convite= a página também abre no Laboratório).
 *
 * O servidor não chama a API: o limite por visitante da API ficaria com o IP do
 * servidor do web, e o /cadastrar passaria a depender da API para abrir.
 */
export default async function CadastrarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tipo, convite } = await searchParams;
  // Código do convite como veio no link; quem confere é a API.
  const codigo = typeof convite === 'string' && convite.trim() ? convite.trim().slice(0, 128) : null;
  const caminho: Caminho =
    codigo || (typeof tipo === 'string' && tipo.toLowerCase() === 'laboratorio') ? 'LABORATORIO' : 'CLINICA';
  return <SignupPage caminhoInicial={caminho} conviteInicial={codigo} />;
}
