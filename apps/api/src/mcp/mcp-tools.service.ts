import { Injectable } from '@nestjs/common';
import { LeadsService } from '../leads/leads.service';

/**
 * Ferramentas MCP expostas à IA. O escopo jurídico (processos, petições,
 * honorários vinculados a caso) foi removido na transição para o domínio
 * odontológico — ferramentas novas (agendamento, orçamento, prontuário)
 * entram nas fases clínicas.
 */
@Injectable()
export class McpToolsService {
  constructor(
    private leads: LeadsService,
  ) {}

  async callTool(name: string, args: Record<string, any>, user: any): Promise<unknown> {
    const tenantId = user?.tenant_id;

    switch (name) {
      // ─── Clientes / Leads ─────────────────────────────────────
      case 'buscar_cliente': {
        if (args.id) return this.leads.findOne(args.id, tenantId);
        return this.leads.findAll(tenantId, undefined, 1, 10, args.query);
      }

      case 'listar_clientes': {
        return this.leads.findAll(
          tenantId,
          args.inboxId,
          args.page ?? 1,
          args.limit ?? 20,
          args.search,
          args.stage,
        );
      }

      case 'criar_cliente': {
        return this.leads.create({
          name: args.name,
          phone: args.phone,
          email: args.email,
          tenant_id: tenantId,
        } as any);
      }

      case 'atualizar_cliente': {
        const { id, name, email, tags } = args;
        return this.leads.update(id, { name, email, tags }, tenantId);
      }

      default:
        throw new Error(`Ferramenta desconhecida: ${name}`);
    }
  }
}
