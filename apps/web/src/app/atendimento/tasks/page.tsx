import { redirect } from 'next/navigation';

/**
 * O menu de Tarefas foi unificado com a Agenda.
 * Esta página redireciona para /atendimento/agenda?tab=tasks
 * mantendo compatibilidade com links e bookmarks existentes.
 */
export default function TasksRedirect() {
  redirect('/atendimento/agenda?tab=tasks');
}
